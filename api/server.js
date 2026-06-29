// Keyless Azure OpenAI proxy for the Nordkapp Roadtrip chat panel.
//
// Runs as a tiny Express app on Azure App Service (Linux, Node). It authenticates
// to Azure OpenAI with its system-assigned MANAGED IDENTITY via DefaultAzureCredential
// — no API keys anywhere (the AOAI resource has key auth disabled by policy). The
// app's managed identity must hold the "Cognitive Services OpenAI User" role on the
// AOAI resource. The browser calls this app (CORS-enabled); the grounding guardrails
// and system prompt are enforced HERE, server-side, so the client cannot weaken them.

import express from "express";
import { DefaultAzureCredential } from "@azure/identity";
import { getTripContext } from "./context.js";

const credential = new DefaultAzureCredential();
const SCOPE = "https://cognitiveservices.azure.com/.default";
let cachedToken = null;

async function getToken() {
  // Reuse the Entra token until ~1 min before expiry.
  if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 60_000) {
    return cachedToken.token;
  }
  cachedToken = await credential.getToken(SCOPE);
  return cachedToken.token;
}

// Grounding guardrails: grounded trip facts are authoritative; general knowledge is
// allowed only for qualitative help and must be labelled.
const SYSTEM_PROMPT = `You are the Nordkapp Roadtrip Copilot, a friendly assistant for one specific road trip from southern Norway up to Nordkapp.

GROUNDING RULES (strict — never break):
- The "TRIP DATA" message is the ONLY source of truth for: weather/forecasts, opening hours, driving distances and times, EV charger locations, stop names, coordinates, and dates. Quote these values; NEVER invent, estimate, or override them.
- Weather: state only what TRIP DATA contains (it comes from MET Norway / Yr.no). If a stop's forecast is missing or beyond range, say so plainly. Never fabricate a forecast.
- Opening hours: if a place has no hours in TRIP DATA, say "not listed" — never guess.
- Distances, route, chargers, coordinates: use only TRIP DATA values.

GENERAL KNOWLEDGE (allowed):
- You MAY use your general knowledge for qualitative help: attractions, history, culture, what to see/do, packing advice, EV/driving tips, food culture, scenery.
- Whenever you add such general knowledge, clearly mark it by starting that part with: "ℹ️ General info (not from your trip data):".

STYLE: concise, practical, warm. Refer to stops by name and use the trip's real dates. If asked a volatile fact you can't find in TRIP DATA, say it's not in the trip data rather than guessing.

FORMATTING (you render inside a NARROW chat panel — keep it scannable):
- Open with a one-line direct answer, then details.
- Prefer short paragraphs (1–2 sentences) and lists over long blocks of text.
- Use "## " or "### " section headings when a reply has more than one topic (e.g. "### 🌦 Weather", "### 🍽 Food").
- Use bullet "- " for options and numbered "1. " for ordered steps/itineraries.
- **Bold** the key fact in a line (temperatures, names, distances, times).
- Keep emoji light and purposeful (one per heading or item at most).
- Do NOT use markdown tables, raw HTML, or huge headings (#). Avoid walls of text.`;

const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED.includes("*")
    ? "*"
    : ALLOWED.includes(origin)
      ? origin
      : ALLOWED[0] || "*";
  res.set("Access-Control-Allow-Origin", allow);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Shared, server-cached trip context (stops + drive + weather + POIs). Lazy +
// stale-while-revalidate, so every session reuses the same canonical data.
app.get("/api/context", async (_req, res) => {
  try {
    const ctx = await getTripContext();
    if (!ctx) return res.status(503).json({ error: "context warming up, retry shortly" });
    res.json(ctx);
  } catch (e) {
    console.error("context build failed:", e?.message || e);
    res.status(500).json({ error: "context unavailable" });
  }
});

app.post("/api/chat", async (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.messages) ? body.messages : [];

  // The client may only supply user/assistant turns; the system prompt is
  // server-controlled and cannot be overridden from the browser.
  const safeMessages = incoming
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-20);

  if (!safeMessages.length) {
    return res.status(400).json({ error: "messages[] (user/assistant) required" });
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  // Prefer the SERVER-cached canonical trip context so every session is grounded
  // identically, regardless of how loaded that browser is. Fall back to whatever
  // the client sent (or the user's live location it may add) only if the cache
  // isn't ready yet.
  let ctxObj = null;
  try {
    ctxObj = await getTripContext();
  } catch (e) {
    console.error("trip context fetch failed:", e?.message || e);
  }
  if (ctxObj == null && body.tripContext != null) ctxObj = body.tripContext;
  if (body.tripContext && typeof body.tripContext === "object" && body.tripContext.userLocation) {
    if (ctxObj && typeof ctxObj === "object") ctxObj.userLocation = body.tripContext.userLocation;
  }
  if (ctxObj != null) {
    const ctx = typeof ctxObj === "string" ? ctxObj : JSON.stringify(ctxObj);
    messages.push({
      role: "system",
      content:
        "TRIP DATA (authoritative — the only source for weather, opening hours, distances, chargers, coordinates, dates):\n" +
        ctx.slice(0, 60000),
    });
  }
  messages.push(...safeMessages);

  const endpoint = (process.env.AOAI_ENDPOINT || "").replace(/\/$/, "");
  const model = process.env.AOAI_DEPLOYMENT || "model-router";
  if (!endpoint) {
    return res.status(500).json({ error: "AOAI_ENDPOINT not configured" });
  }

  let token;
  try {
    token = await getToken();
  } catch (e) {
    console.error("Managed-identity token acquisition failed:", e?.message || e);
    return res.status(500).json({ error: "Auth failed (managed identity)" });
  }

  const url = `${endpoint}/openai/v1/chat/completions`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
        // model-router may route to a reasoning model that spends tokens on hidden
        // reasoning, so keep a generous default to avoid empty/truncated replies.
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1500,
      }),
    });
  } catch (e) {
    console.error("Upstream fetch to Azure OpenAI failed:", e?.message || e);
    return res.status(502).json({ error: "Upstream request failed" });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    console.error(`Azure OpenAI returned ${upstream.status}: ${text.slice(0, 500)}`);
    return res
      .status(upstream.status)
      .json({ error: "Model call failed", detail: text.slice(0, 500) });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return res.status(502).json({ error: "Bad upstream response" });
  }

  const reply = data?.choices?.[0]?.message?.content ?? "";
  return res.json({ reply, usage: data?.usage ?? null });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Nordkapp AI proxy listening on ${port}`));
