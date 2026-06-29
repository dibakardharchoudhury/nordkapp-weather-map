// Keyless Azure OpenAI proxy for the Nordkapp Roadtrip chat panel.
//
// Runs as a tiny Express app on Azure App Service (Linux, Node). It authenticates
// to Azure OpenAI with its system-assigned MANAGED IDENTITY via DefaultAzureCredential
// — no API keys anywhere (the AOAI resource has key auth disabled by policy). The
// app's managed identity must hold the "Cognitive Services OpenAI User" role on the
// AOAI resource. The browser calls this app (CORS-enabled); the grounding guardrails
// and system prompt are enforced HERE, server-side, so the client cannot weaken them.

import express from "express";
import rateLimit from "express-rate-limit";
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
- If the user sends a PHOTO, you MAY read, translate, and explain its visible content (road signs, menus, labels, info boards, landmarks). For Norwegian text, give the clear English meaning. Treat this as general knowledge — never let an image override TRIP DATA facts.
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
  // Fail CLOSED: only emit an allow header when the caller's origin is explicitly
  // permitted (or the allowlist is the wildcard). Unknown origins get no header,
  // so the browser blocks the response. CORS is a browser control only — the
  // rate limiters below are what actually stop non-browser (curl/script) abuse.
  let allow = null;
  if (ALLOWED.includes("*")) allow = "*";
  else if (origin && ALLOWED.includes(origin)) allow = origin;
  if (allow) {
    res.set("Access-Control-Allow-Origin", allow);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "86400");
  }
}

const app = express();
// App Service terminates TLS at a single reverse proxy and forwards the real
// client IP in X-Forwarded-For; trust exactly one hop so per-IP limits key off
// the true caller (and can't be spoofed by adding extra XFF entries).
app.set("trust proxy", 1);
// Larger limit than a pure-text chat needs, so a downscaled photo (Snap &
// Translate) fits. Per-image size is capped again in sanitizeContent below.
app.use(express.json({ limit: "6mb" }));
app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Per-IP rate limits — defend against brute-force / scripted abuse and runaway
// token cost on the public endpoint. A broad cap on everything, plus a tight cap
// on the expensive model call.
// App Service puts the real client IP (as "ip:port") in X-Forwarded-For and
// req.ip — with trust proxy=1 — resolves to that platform-set value, which a
// caller CANNOT spoof (unlike the leftmost XFF entry). Strip the port so all
// requests from one client share a counter.
function clientKey(req) {
  let ip = req.ip || "";
  ip = ip.replace(/^\[(.+)\]:\d+$/, "$1");        // [ipv6]:port -> ipv6
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, ""); // ipv4:port -> ipv4
  return ip || "unknown";
}
const rlOpts = { standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey, message: { error: "Too many requests — slow down and retry shortly." } };
const globalLimiter = rateLimit({ windowMs: 60_000, max: 60, ...rlOpts });
const chatLimiter = rateLimit({ windowMs: 60_000, max: 15, ...rlOpts });
app.use(globalLimiter);

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

// === Together mode — ephemeral live-location relay for the travelling family ===
// In-memory ONLY (no database, nothing persisted): each member POSTs their coarse
// GPS and we echo back the other members seen within a short TTL. Privacy by
// design — entries self-expire, and rooms/members are capped to bound abuse. The
// existing per-IP rate limiter (globalLimiter) protects this endpoint too.
const TOGETHER_TTL_MS = 300_000;    // a member lingers (dimmed by the client after 20s) for 5 min after their last ping — covers multi-minute tunnels & locked screens; explicit leave drops them instantly
const TOGETHER_MAX_MEMBERS = 8;     // per room — one slot per car (3 cars); headroom covers mixed app versions during rollout
const TOGETHER_MAX_ROOMS = 500;
const togetherRooms = new Map();    // room -> Map(id -> { name, lat, lng, ts })

function pruneTogether(room) {
  const m = togetherRooms.get(room);
  if (!m) return;
  const cutoff = Date.now() - TOGETHER_TTL_MS;
  for (const [id, v] of m) if (v.ts < cutoff) m.delete(id);
  if (m.size === 0) togetherRooms.delete(room);
}

const cleanRoom = (s) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "");
const cleanMemberId = (s) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "");
const cleanMemberName = (s) => (typeof s === "string" ? s.replace(/[<>]/g, "").trim().slice(0, 24) : "");
const finiteIn = (n, lo, hi) => typeof n === "number" && isFinite(n) && n >= lo && n <= hi;

app.post("/api/together", (req, res) => {
  const b = req.body || {};
  const room = cleanRoom(b.room);
  const id = cleanMemberId(b.id);
  if (!room || !id) return res.status(400).json({ error: "room and id required" });

  // Explicit leave — when a member exits Together mode (or closes the app) we remove
  // them at once so the rest of the family sees them drop offline immediately,
  // instead of lingering until the 5-minute TTL prunes them.
  if (b.leave === true) {
    const mm = togetherRooms.get(room);
    if (mm) { mm.delete(id); if (mm.size === 0) togetherRooms.delete(room); }
    return res.json({ ok: true, members: [], serverTime: Date.now() });
  }

  // Position is optional — a member may poll for others before broadcasting (i.e.
  // before they've opted in by entering a name). We only store a fix when present.
  if (finiteIn(b.lat, -90, 90) && finiteIn(b.lng, -180, 180)) {
    let m = togetherRooms.get(room);
    if (!m) {
      if (togetherRooms.size >= TOGETHER_MAX_ROOMS) togetherRooms.delete(togetherRooms.keys().next().value);
      m = new Map();
      togetherRooms.set(room, m);
    }
    if (!m.has(id) && m.size >= TOGETHER_MAX_MEMBERS) return res.status(429).json({ error: "room full" });
    const acc = finiteIn(b.acc, 0, 100000) ? b.acc : null; // GPS accuracy radius (m), if reported
    m.set(id, { name: cleanMemberName(b.name) || "Traveller", lat: b.lat, lng: b.lng, acc, ts: Date.now() });
  }

  pruneTogether(room);
  const m = togetherRooms.get(room);
  const members = [];
  if (m) for (const [mid, v] of m) {
    if (mid === id) continue; // the caller already knows their own position
    members.push({ id: mid, name: v.name, lat: v.lat, lng: v.lng, acc: v.acc ?? null, ts: v.ts });
  }
  res.json({ ok: true, members, serverTime: Date.now() });
});

// Sanitise one message's content. Accepts either a plain non-empty string, or a
// multimodal array of {type:"text"} / {type:"image_url"} parts (Snap & Translate).
// Image parts are capped (count + size, data: or https only) to bound cost/abuse.
function sanitizeContent(content) {
  if (typeof content === "string") return content.trim() ? content : null;
  if (Array.isArray(content)) {
    const parts = [];
    let imgs = 0;
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        parts.push({ type: "text", text: p.text.slice(0, 4000) });
      } else if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string" && imgs < 2) {
        const url = p.image_url.url;
        if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url) && url.length <= 7_000_000) {
          parts.push({ type: "image_url", image_url: { url } });
          imgs++;
        } else if (/^https:\/\//i.test(url) && url.length <= 2000) {
          parts.push({ type: "image_url", image_url: { url } });
          imgs++;
        }
      }
    }
    return parts.length ? parts : null;
  }
  return null;
}

// Build the grounded message array — system prompt + authoritative TRIP DATA +
// the client's (sanitised) user/assistant turns. Shared by the JSON and the
// streaming chat routes so both ground identically.
async function buildGroundedMessages(body) {
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  // The client may only supply user/assistant turns; the system prompt is
  // server-controlled and cannot be overridden from the browser. Content is
  // either a plain string OR a multimodal array (text + image parts, for Snap &
  // Translate); both are sanitised here.
  const safeMessages = incoming
    .map((m) => {
      if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
      const content = sanitizeContent(m.content);
      return content ? { role: m.role, content } : null;
    })
    .filter(Boolean)
    .slice(-20);
  if (!safeMessages.length) return { error: "messages[] (user/assistant) required", status: 400 };

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  // Ground on EXACTLY what the user sees: the client's live dataset (POIs +
  // facilities + weather, including anything loaded dynamically) is authoritative.
  // The server cache is only a fallback when the client sent no usable context
  // (e.g. first paint before the trip loads), so every session stays consistent.
  const clientCtx = body.tripContext;
  const clientHasData = clientCtx && typeof clientCtx === "object" && Array.isArray(clientCtx.days) && clientCtx.days.length;
  let ctxObj = clientHasData ? clientCtx : null;
  if (ctxObj == null) {
    try {
      ctxObj = await getTripContext();
    } catch (e) {
      console.error("trip context fetch failed:", e?.message || e);
    }
    // keep the user's live location when grounding falls back to the server cache
    if (ctxObj && clientCtx && typeof clientCtx === "object" && clientCtx.userLocation) ctxObj.userLocation = clientCtx.userLocation;
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
  return { messages };
}

app.post("/api/chat", chatLimiter, async (req, res) => {
  const body = req.body || {};
  const built = await buildGroundedMessages(body);
  if (built.error) return res.status(built.status).json({ error: built.error });
  const messages = built.messages;

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

// Streaming variant — identical grounding, but relays the model's tokens as they
// arrive (Server-Sent Events) so the chat panel can render incrementally. The
// upstream Azure OpenAI SSE frames are forwarded verbatim; the browser parses
// `choices[0].delta.content` and the final usage chunk. Additive — the original
// /api/chat stays the canonical JSON endpoint.
app.post("/api/chat/stream", chatLimiter, async (req, res) => {
  const body = req.body || {};
  const built = await buildGroundedMessages(body);
  if (built.error) return res.status(built.status).json({ error: built.error });

  const endpoint = (process.env.AOAI_ENDPOINT || "").replace(/\/$/, "");
  const model = process.env.AOAI_DEPLOYMENT || "model-router";
  if (!endpoint) return res.status(500).json({ error: "AOAI_ENDPOINT not configured" });

  let token;
  try {
    token = await getToken();
  } catch (e) {
    console.error("Managed-identity token acquisition failed:", e?.message || e);
    return res.status(500).json({ error: "Auth failed (managed identity)" });
  }

  let upstream;
  try {
    upstream = await fetch(`${endpoint}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: built.messages,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1500,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (e) {
    console.error("Upstream stream fetch to Azure OpenAI failed:", e?.message || e);
    return res.status(502).json({ error: "Upstream request failed" });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error(`Azure OpenAI stream returned ${upstream.status}: ${text.slice(0, 500)}`);
    return res.status(upstream.status || 502).json({ error: "Model call failed", detail: text.slice(0, 500) });
  }

  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const onClose = () => { try { upstream.body.cancel?.(); } catch { /* ignore */ } };
  req.on("close", onClose);
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    console.error("stream relay error:", e?.message || e);
  } finally {
    req.off("close", onClose);
    res.end();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Nordkapp AI proxy listening on ${port}`));
