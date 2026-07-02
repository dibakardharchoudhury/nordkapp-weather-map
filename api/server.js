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
import { createHash, timingSafeEqual } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { getTripContext } from "./context.js";
import { recordAnalytics, analyticsSummary, ensureAnalyticsLoaded } from "./analytics.js";
import { pushEnabled, publicKey as vapidPublicKey, saveSubscription, removeSubscription, notifyRoom, notifyEndpoint, roomHasSubs } from "./push.js";

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

COORDINATES: TRIP DATA includes GPS coordinates so you can reason about distance/proximity, but NEVER print latitude/longitude in your reply unless the user EXPLICITLY asks for coordinates. Always refer to places by name and town only.

FORMATTING (you render inside a NARROW chat panel — keep it scannable):
- Open with a one-line direct answer, then details.
- Prefer short paragraphs (1–2 sentences) and lists over long blocks of text.
- Use "## " or "### " section headings when a reply has more than one topic (e.g. "### 🌦 Weather", "### 🍽 Food").
- Use bullet "- " for options and numbered "1. " for ordered steps/itineraries.
- **Bold** the key fact in a line (temperatures, names, distances, times).
- Keep emoji light and purposeful (one per heading or item at most).
- Never print GPS coordinates or latitude/longitude unless explicitly asked — name the place and town instead.
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
    res.set("Access-Control-Allow-Headers", "Content-Type, x-analytics-key");
    // Short preflight cache: if the CORS policy ever changes again, browsers
    // re-check within minutes instead of being pinned to a stale (broken) preflight
    // for a whole day.
    res.set("Access-Control-Max-Age", "600");
  }
}

const app = express();
// App Service terminates TLS at a single reverse proxy and forwards the real
// client IP in X-Forwarded-For; trust exactly one hop so per-IP limits key off
// the true caller (and can't be spoofed by adding extra XFF entries).
app.set("trust proxy", 1);
app.disable("x-powered-by"); // don't advertise the framework/version to attackers
// Larger limit than a pure-text chat needs, so a downscaled photo (Snap &
// Translate) fits. Per-image size is capped again in sanitizeContent below.
app.use(express.json({ limit: "6mb" }));
app.use((req, res, next) => {
  applyCors(req, res);
  res.setHeader("X-Content-Type-Options", "nosniff"); // stop MIME-sniffing of JSON replies
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
// Dedicated, tight throttle for the key-gated dashboard read. Only FAILED
// attempts count (skipSuccessfulRequests), so a legitimate operator with the
// right key is never blocked, while key-guessing is capped at 10/min/IP — far
// below the global 60/min — and trips a 429 long before any sweep can progress.
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, skipSuccessfulRequests: true, ...rlOpts });
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
const TOGETHER_TTL_MS = 3_600_000;  // BACKSTOP only — prune a member 60 min after their last CONTACT (seen). Removal is intent-driven: an explicit Stop / exit / clean app close drops a car instantly (leave). This long window exists solely to mop up UN-clean exits (crash, force-kill, battery death) where no leave signal was sent. A car with coverage but no fix (long tunnel, screen on) keepalive-pings so it never prunes; a car in a real no-signal dead zone (e.g. Tromsø↔Hammerfest) can't ping, so the family keeps its last-known spot dimmed as "signal lost · last seen Xm ago" for up to this window, then it clears.
const TOGETHER_MAX_MEMBERS = 8;     // per room — 3 cars + up to 2 viewers = 5; headroom covers mixed app versions during rollout
const TOGETHER_MAX_VIEWERS = 2;     // per room — read-only "viewer" role is capped separately from the cars; a 3rd viewer evicts the stalest one
const TOGETHER_MAX_ROOMS = 500;
const togetherRooms = new Map();    // room -> Map(id -> { name, lat, lng, acc, role, ts, seen }) — role "car"|"viewer"; ts = last fix time (drives client staleness); seen = last contact (drives TTL prune)

function pruneTogether(room) {
  const m = togetherRooms.get(room);
  if (!m) return;
  const cutoff = Date.now() - TOGETHER_TTL_MS;
  for (const [id, v] of m) if ((v.seen ?? v.ts) < cutoff) m.delete(id);
  if (m.size === 0) togetherRooms.delete(room);
}

const cleanRoom = (s) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "");
const cleanMemberId = (s) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "");
const cleanMemberName = (s) => (typeof s === "string" ? s.replace(/[<>]/g, "").trim().slice(0, 24) : "");
const finiteIn = (n, lo, hi) => typeof n === "number" && isFinite(n) && n >= lo && n <= hi;

function handleTogether(req, res) {
  const b = req.body || {};
  const room = cleanRoom(b.room);
  const id = cleanMemberId(b.id);
  if (!room || !id) return res.status(400).json({ error: "room and id required" });
  let newViewer = null; // set when a brand-new viewer registers, so we can push the family after responding

  // Explicit leave — when a member exits Together mode (or closes the app) we remove
  // them at once so the rest of the family sees them drop offline immediately,
  // instead of lingering until the 60-minute backstop TTL prunes them. This is the
  // primary removal path; the TTL is only a safety net for un-clean exits.
  if (b.leave === true) {
    const mm = togetherRooms.get(room);
    if (mm) { mm.delete(id); if (mm.size === 0) togetherRooms.delete(room); }
    return res.json({ ok: true, members: [], serverTime: Date.now() });
  }

  // Position is optional — a member may poll for others before broadcasting (i.e.
  // before they've opted in by entering a name). We only store a fix when present.
  const now = Date.now();
  if (b.keepalive === true) {
    // Keepalive — a joined car with no fresh fix (e.g. inside a long tunnel, screen on) pings
    // under its REAL id with no coordinates to say "still here". Refresh only its `seen` so it
    // isn't pruned, WITHOUT touching its last-known position or `ts` — the family keeps it on the
    // map dimmed as "signal lost" for the whole tunnel, and it snaps back to live on the next fix.
    const mm = togetherRooms.get(room);
    const v = mm && mm.get(id);
    if (v) v.seen = now;
  } else if (finiteIn(b.lat, -90, 90) && finiteIn(b.lng, -180, 180)) {
    let m = togetherRooms.get(room);
    if (!m) {
      if (togetherRooms.size >= TOGETHER_MAX_ROOMS) togetherRooms.delete(togetherRooms.keys().next().value);
      m = new Map();
      togetherRooms.set(room, m);
    }
    // A member is either a car (the travelling fleet, default) or a read-only
    // "viewer" who only watches the cars. Viewers still share their own location so
    // the family can see who's watching and from where, but they're capped SEPARATELY
    // from the cars so a crowd of viewers can never crowd the fleet out of the room.
    const role = b.role === "viewer" ? "viewer" : "car";
    // A NEW viewer (first registration under this id) triggers a push to the cars so
    // the family is told someone started watching, even with the app closed.
    if (role === "viewer" && !m.has(id) && pushEnabled) {
      newViewer = { name: cleanMemberName(b.name) || "Viewer", lat: b.lat, lng: b.lng };
    }
    if (!m.has(id) && role === "viewer") {
      // Enforce the viewer cap the same forgiving way as the room cap: never reject a
      // (re)join — instead, when a NEW viewer arrives and the room is already at the
      // viewer limit, evict the STALEST viewer (oldest last-contact). Same-id rejoins
      // upsert below via m.has(id), so a returning viewer keeps its slot.
      let viewers = 0, evictId = null, oldest = Infinity;
      for (const [eid, ev] of m) {
        if (ev.role !== "viewer") continue;
        viewers++;
        const s = ev.seen ?? ev.ts ?? 0;
        if (s < oldest) { oldest = s; evictId = eid; }
      }
      if (viewers >= TOGETHER_MAX_VIEWERS && evictId) m.delete(evictId);
    }
    if (!m.has(id) && m.size >= TOGETHER_MAX_MEMBERS) {
      // Never reject a (re)join with "room full". The cap bounds memory, but a real
      // traveller must ALWAYS be able to join/rejoin and resume tracking — so instead of
      // a 429 we evict the STALEST member (oldest last-contact). Live cars refresh `seen`
      // every few sec (broadcast or keepalive), so the evictee is always an abandoned
      // ghost, never an active car. Same-id rejoins never reach here — they upsert below
      // via m.has(id), so a returning car simply overwrites its own slot with the latest fix.
      let evictId = null, oldest = Infinity;
      for (const [eid, ev] of m) {
        const s = ev.seen ?? ev.ts ?? 0;
        if (s < oldest) { oldest = s; evictId = eid; }
      }
      if (evictId) m.delete(evictId);
    }
    const acc = finiteIn(b.acc, 0, 100000) ? b.acc : null; // GPS accuracy radius (m), if reported
    m.set(id, { name: cleanMemberName(b.name) || "Traveller", lat: b.lat, lng: b.lng, acc, role, ts: now, seen: now });
  }

  pruneTogether(room);
  const m = togetherRooms.get(room);
  const members = [];
  if (m) for (const [mid, v] of m) {
    if (mid === id) continue; // the caller already knows their own position
    members.push({ id: mid, name: v.name, lat: v.lat, lng: v.lng, acc: v.acc ?? null, role: v.role || "car", ts: v.ts });
  }
  res.json({ ok: true, members, serverTime: Date.now() });
  // Fire-and-forget: tell the fleet (via Web Push) that a new viewer is watching,
  // reverse-geocoding their coarse position to a readable place. Guarded by pushEnabled
  // so the unit tests (no VAPID env) never hit the network here.
  if (newViewer && pushEnabled) notifyViewerJoined(room, newViewer);
}
app.post("/api/together", handleTogether);

// Best-effort reverse geocode to a short "Town, Region" label (server-side; App
// Service egress can reach Nominatim). Returns null on any failure.
async function reverseGeocodeShort(lat, lng) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    let d;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat}&lon=${lng}`,
        { headers: { "User-Agent": "NordkappRoadtrip/1.0 github.com/dibakardharchoudhury/nordkapp-weather-map" }, signal: ctl.signal });
      if (!r.ok) return null;
      d = await r.json();
    } finally { clearTimeout(t); }
    const a = (d && d.address) || {};
    const town = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
    const region = a.county || a.state;
    return [town, region].filter(Boolean).slice(0, 2).join(", ") || (d && d.name) || null;
  } catch { return null; }
}

// Push "a viewer just joined" to the cars (not to viewers).
async function notifyViewerJoined(room, viewer) {
  try {
    const place = (Number.isFinite(viewer.lat) && Number.isFinite(viewer.lng))
      ? await reverseGeocodeShort(viewer.lat, viewer.lng) : null;
    const loc = place ? ` from ${place}` : "";
    await notifyRoom(room, {
      title: "\uD83D\uDC41\uFE0F New viewer watching",
      body: `${viewer.name} just joined as a viewer${loc} and can see the cars' live positions.`,
      tag: "viewer-joined",
      url: "./index.html",
    }, { role: "car" });
  } catch (e) { console.error("[push] viewer-join notify:", e?.message || e); }
}

// === Web Push — critical trip alerts (weather, "hurry up", viewer joined) ===
// Keyless (VAPID). Subscribe/unsubscribe are open (a browser registers its own push
// endpoint); the global rate limiter covers them. /config lets the client fetch the
// public key so it's never hard-coded/rotation-locked.
app.get("/api/push/config", (req, res) => res.json({ enabled: pushEnabled, publicKey: vapidPublicKey || "" }));
app.post("/api/push/subscribe", (req, res) => {
  const b = req.body || {};
  res.json(saveSubscription({ sub: b.sub, name: b.name, role: b.role, room: b.room }));
});
app.post("/api/push/unsubscribe", (req, res) => {
  const ep = (req.body && req.body.endpoint) || "";
  if (!ep) return res.status(400).json({ error: "endpoint required" });
  res.json(removeSubscription(ep));
});
// Fire a test alert so a user can confirm notifications work end-to-end.
app.post("/api/push/test", async (req, res) => {
  const b = req.body || {};
  try {
    let out;
    if (b.endpoint) out = await notifyEndpoint(b.endpoint, { title: "🔔 Trip alerts are on", body: "Test alert — you'll get weather, hurry-up and viewer notifications here.", tag: "test" });
    else if (b.room) out = await notifyRoom(b.room, { title: "🔔 Trip alerts test", body: "Test alert for the family.", tag: "test" }, { name: b.name });
    else return res.status(400).json({ error: "endpoint or room required" });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e?.message || "send failed" }); }
});

// === Pace engine — a gentle "you've been parked a while" nudge to curb over-long
// stops. Reads the live Together relay only (no fragile schedule math): if a car
// that's actively sharing hasn't moved for a while during the day, we push its own
// devices once (with a cooldown). Location-based, so it only fires while a car is
// sharing; it never nags (one nudge per car per hour).
const DWELL_NUDGE_MS = 15 * 60 * 1000;    // parked this long → nudge
const DWELL_COOLDOWN_MS = 60 * 60 * 1000; // at most one nudge per car per hour
const DWELL_MOVE_KM = 0.15;               // moved more than this → reset the dwell clock
const dwellState = new Map();             // "room|id" → { lat, lng, since, notifiedAt }

function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function evaluatePace() {
  if (!pushEnabled) return;
  const now = Date.now();
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "Europe/Oslo", hour: "2-digit", hour12: false }));
  const daytime = hour >= 8 && hour <= 22; // don't nudge in the middle of the night
  for (const [room, members] of togetherRooms) {
    if (!roomHasSubs(room)) continue;
    for (const [id, v] of members) {
      if (v.role === "viewer") continue;                       // only nudge the cars
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
      if (now - (v.seen ?? v.ts) > 3 * 60 * 1000) continue;    // only cars currently sharing
      const key = room + "|" + id;
      const st = dwellState.get(key);
      if (!st) { dwellState.set(key, { lat: v.lat, lng: v.lng, since: now, notifiedAt: 0 }); continue; }
      if (distKm(st.lat, st.lng, v.lat, v.lng) > DWELL_MOVE_KM) { st.lat = v.lat; st.lng = v.lng; st.since = now; continue; }
      const parkedMs = now - st.since;
      if (daytime && parkedMs >= DWELL_NUDGE_MS && (now - st.notifiedAt) > DWELL_COOLDOWN_MS) {
        st.notifiedAt = now;
        const mins = Math.round(parkedMs / 60000);
        notifyRoom(room, {
          title: "⏱️ Long stop?",
          body: `You've been parked about ${mins} min. If it's getting late, it may be time to head to the next stop.`,
          tag: "dwell-" + id,
          url: "./index.html",
        }, { name: v.name, role: "car" }).catch(() => {});
      }
    }
  }
  // Forget dwell state for members who have left the room.
  for (const key of [...dwellState.keys()]) {
    const sep = key.indexOf("|");
    const rm = togetherRooms.get(key.slice(0, sep));
    if (!rm || !rm.has(key.slice(sep + 1))) dwellState.delete(key);
  }
}
// Run the evaluator on a timer, but never in the test harness (PORT=0) and never
// when push is off. unref() so it can't keep the process alive on its own.
if (pushEnabled && process.env.PORT !== "0") {
  const paceTimer = setInterval(() => { evaluatePace().catch(() => {}); }, 60_000);
  if (paceTimer.unref) paceTimer.unref();
}

// === Traffic analytics ===
// Ingest is open (any visitor's browser beacons here) and must NEVER fail the page;
// the dashboard read is gated behind ANALYTICS_KEY when one is configured, because
// the summary exposes IPs, geo and GPS. The per-IP rate limiter covers both.
app.post("/api/analytics", async (req, res) => {
  try { await recordAnalytics(req.body, req.headers["user-agent"], clientKey(req)); }
  catch (e) { console.error("analytics ingest failed:", e?.message || e); }
  res.json({ ok: true });
});

const ANALYTICS_KEY = process.env.ANALYTICS_KEY || "";
// Constant-time, length-independent compare (hash both sides to a fixed 32 bytes)
// so a wrong key can't be inferred from response timing.
function keyEquals(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
app.get("/api/analytics/summary", authLimiter, async (req, res) => {
  if (ANALYTICS_KEY) {
    const k = req.get("x-analytics-key") || req.query.key || "";
    if (!keyEquals(k, ANALYTICS_KEY)) return res.status(401).json({ error: "analytics key required" });
  }
  await ensureAnalyticsLoaded(); // hydrate persisted history on a cold start
  const tz = typeof req.query.tz === "string" ? req.query.tz : "UTC";
  const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : null;
  res.json(analyticsSummary({ tz, day }));
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
    // Cap the grounded context, but keep it big enough to hold the WHOLE trip. The
    // client sends every day + stop with live weather + POIs (~77 KB measured for this
    // 18-day / 156-stop trip, a bit more once every stop's POIs are enriched). The old
    // 60 KB cap silently truncated the JSON mid-trip, so the model only saw ~14 days
    // and swore the rest didn't exist. 400 KB fits the full trip with generous headroom
    // (for longer trips / richer POIs) while still bounding a runaway payload.
    messages.push({
      role: "system",
      content:
        "TRIP DATA (authoritative — the only source for weather, opening hours, distances, chargers, coordinates, dates):\n" +
        ctx.slice(0, 400000),
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
        // reasoning, so keep a generous default to avoid empty/truncated replies. It's
        // only a CAP — short answers stop on their own; this lets a long reply (e.g. a
        // full 18-day day-by-day summary) finish instead of cutting off mid-trip.
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 4000,
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
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 4000,
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

// Additive named exports — used only by the Together-mode unit tests
// (api/together.test.mjs). They expose the in-memory relay internals so the
// handler can be exercised with mock req/res and time-controlled state. The
// running server's behaviour is unchanged.
export {
  handleTogether,
  togetherRooms,
  pruneTogether,
  cleanRoom,
  cleanMemberId,
  cleanMemberName,
  finiteIn,
  TOGETHER_TTL_MS,
  TOGETHER_MAX_MEMBERS,
  TOGETHER_MAX_VIEWERS,
  TOGETHER_MAX_ROOMS,
};
