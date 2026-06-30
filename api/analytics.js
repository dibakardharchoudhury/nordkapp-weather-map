// Lightweight, keyless traffic analytics for the Nordkapp Roadtrip app.
//
// No database and no third-party tracker: events are appended to a JSON-lines
// file on the App Service persistent volume (/home/data) and also kept in a
// capped in-memory ring so summaries are instant. We capture a random per-browser
// visitor id, a friendly device label, the client IP (for coarse geo via ipwho.is)
// and an optional precise GPS fix when the visitor has shared one. Because this is
// sensitive, GET /api/analytics/summary is gated behind ANALYTICS_KEY when set.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE = process.env.NA_ANALYTICS_FILE ||
  path.join(process.env.HOME || os.tmpdir(), "data", "analytics.jsonl");
const PERSIST = process.env.NA_ANALYTICS_NOFILE !== "1";
console.log(`[analytics] persist=${PERSIST} file=${FILE} HOME=${process.env.HOME || "(unset)"}`);
const MAX_MEM = 20000;          // cap the in-memory ring (and the startup re-load)
const LIVE_MS = 5 * 60_000;     // a session counts as "live" if seen in the last 5 min
const TYPES = new Set(["pageview", "heartbeat", "event"]);

const events = [];              // recent events (capped at MAX_MEM)
let loaded = false;
let writeChain = Promise.resolve();

const clean = (s, n) => (typeof s === "string" ? s.replace(/[<>]/g, "").trim().slice(0, n) : "");
const cleanId = (s, n) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, n) : "");

// Best-effort OS / browser / form-factor from the User-Agent header (server-side
// so the client can't spoof the breakdown). Deliberately coarse.
export function parseUA(ua = "") {
  const u = String(ua || "");
  let osName = "Unknown";
  if (/Windows NT/.test(u)) osName = "Windows";
  else if (/Android/.test(u)) osName = "Android";
  else if (/iPhone|iPad|iPod/.test(u)) osName = "iOS";
  else if (/Mac OS X|Macintosh/.test(u)) osName = "macOS";
  else if (/CrOS/.test(u)) osName = "ChromeOS";
  else if (/Linux/.test(u)) osName = "Linux";

  let browser = "Unknown";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\/|Opera/.test(u)) browser = "Opera";
  else if (/SamsungBrowser/.test(u)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS/.test(u)) browser = "Firefox";
  else if (/Chrome\/|CriOS/.test(u)) browser = "Chrome";
  else if (/Safari\//.test(u) && /Version\//.test(u)) browser = "Safari";

  const deviceType = /iPad|Tablet/.test(u) ? "Tablet"
    : /Mobile|Android|iPhone|iPod/.test(u) ? "Mobile" : "Desktop";
  return { os: osName, browser, deviceType };
}

// --- IP geolocation (cached, best-effort) ---------------------------------
// Private/loopback ranges never get looked up (no point, and keeps tests offline).
const ipGeo = new Map(); // ip -> { country, countryCode, region, city, lat, lon, isp } | { pending } | {}
const isPrivateIp = (ip) =>
  !ip || ip === "unknown" ||
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
  /^(::1|fc|fd|fe80)/i.test(ip);

async function lookupGeo(ip) {
  if (isPrivateIp(ip) || ipGeo.has(ip)) return;
  ipGeo.set(ip, { pending: true });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    let d;
    try {
      const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
      d = await r.json();
    } finally { clearTimeout(t); }
    if (d && d.success) {
      ipGeo.set(ip, {
        country: d.country, countryCode: d.country_code, region: d.region, city: d.city,
        lat: d.latitude, lon: d.longitude, isp: d.connection && d.connection.isp,
      });
    } else { ipGeo.set(ip, {}); }
  } catch { ipGeo.set(ip, {}); }
}
const geoFor = (ip) => { const g = ipGeo.get(ip); return g && !g.pending ? g : null; };

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!PERSIST) return;
  try {
    const txt = await fs.readFile(FILE, "utf8");
    const lines = txt.split("\n").filter(Boolean).slice(-MAX_MEM);
    for (const ln of lines) { try { events.push(JSON.parse(ln)); } catch { /* skip bad line */ } }
  } catch { /* no file yet */ }
}

// Hydrate the in-memory ring from the persisted JSONL (idempotent). The summary
// endpoint awaits this so the dashboard shows full history right after a cold start,
// not just events seen since the process booted.
export const ensureAnalyticsLoaded = ensureLoaded;

function pushMem(ev) {
  events.push(ev);
  if (events.length > MAX_MEM) events.splice(0, events.length - MAX_MEM);
}

async function appendFile(ev) {
  if (!PERSIST) return;
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      await fs.appendFile(FILE, JSON.stringify(ev) + "\n");
    } catch (e) { console.error(`[analytics] write failed for ${FILE}:`, e?.message || e); }
  });
  return writeChain;
}

// Ingest one beacon. `raw` is the client body; `ua` is the request User-Agent;
// `ip` is the (proxy-trusted) client IP. Returns the stored event, or null if invalid.
export async function recordAnalytics(raw, ua, ip) {
  await ensureLoaded();
  const b = raw || {};
  const type = TYPES.has(b.type) ? b.type : null;
  const visitorId = cleanId(b.visitorId, 64);
  const sessionId = cleanId(b.sessionId, 64);
  if (!type || !visitorId || !sessionId) return null;

  const clientIp = cleanId(String(ip || ""), 45) || "unknown";
  lookupGeo(clientIp); // fire-and-forget; result is cached for this + later events

  // Optional live GPS (only sent when the visitor has a location fix available).
  const gps = (typeof b.lat === "number" && isFinite(b.lat) && b.lat >= -90 && b.lat <= 90 &&
               typeof b.lng === "number" && isFinite(b.lng) && b.lng >= -180 && b.lng <= 180)
    ? { lat: b.lat, lng: b.lng, acc: (typeof b.acc === "number" && isFinite(b.acc)) ? b.acc : null,
        place: clean(b.place, 80) || null }
    : null;

  const { os: osName, browser, deviceType } = parseUA(ua);
  const ev = {
    ts: Date.now(),
    type,
    event: clean(b.event, 48) || null,           // for type:"event" (e.g. "together_join")
    visitorId,                                   // stable per-browser device id
    sessionId,
    name: clean(b.name, 24) || null,             // who (Together identity), if known
    device: clean(b.device, 40) || `${osName} · ${browser}`, // friendly device name (renamable)
    os: osName,
    browser,
    deviceType,
    ip: clientIp,
    gps,
    page: clean(b.path, 64) || "/",
    screen: clean(b.screen, 16) || null,
    tz: clean(b.tz, 48) || null,
    ref: clean(b.ref, 64) || null,
  };
  pushMem(ev);
  appendFile(ev);
  return ev;
}

const ymd = (t, tz) => {
  // Bucket by the configured display tz when possible, else UTC.
  try { return new Date(t).toLocaleDateString("en-CA", { timeZone: tz || "UTC" }); }
  catch { return new Date(t).toISOString().slice(0, 10); }
};
const ymdh = (t) => new Date(t).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

function topCounts(map, limit = 12) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Build the dashboard payload. opts.day = "YYYY-MM-DD" adds that day's 24 hourly
// buckets (the drill-down). opts.tz controls daily bucketing.
export function analyticsSummary(opts = {}) {
  const now = Date.now();
  const tz = opts.tz || "UTC";

  const sessions = new Map();   // sessionId -> aggregate
  const visitors = new Set();
  const byDevice = new Map(), byOS = new Map(), byBrowser = new Map(),
        byType = new Map(), byDeviceType = new Map(), byPerson = new Map(), byPage = new Map(),
        byCountry = new Map(), byCity = new Map();
  const daily = new Map(), hourly = new Map(), dayHours = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  const since48 = now - 48 * 3_600_000;

  for (const e of events) {
    visitors.add(e.visitorId);
    inc(byType, e.type);

    let s = sessions.get(e.sessionId);
    if (!s) {
      s = { sessionId: e.sessionId, visitorId: e.visitorId, name: e.name, device: e.device,
            os: e.os, browser: e.browser, deviceType: e.deviceType, page: e.page, ip: e.ip, gps: e.gps,
            startedAt: e.ts, lastSeen: e.ts, events: 0, pageviews: 0 };
      sessions.set(e.sessionId, s);
    }
    s.lastSeen = Math.max(s.lastSeen, e.ts);
    s.startedAt = Math.min(s.startedAt, e.ts);
    s.events++;
    if (e.type === "pageview") s.pageviews++;
    if (e.name) s.name = e.name;
    if (e.device) s.device = e.device;
    if (e.page) s.page = e.page;
    if (e.ip && e.ip !== "unknown") s.ip = e.ip;
    if (e.gps) s.gps = e.gps; // keep the latest known GPS fix for the session

    const d = ymd(e.ts, tz);
    if (!daily.has(d)) daily.set(d, { date: d, events: 0, sessions: new Set(), pageviews: 0 });
    const dd = daily.get(d); dd.events++; dd.sessions.add(e.sessionId);
    if (e.type === "pageview") dd.pageviews++;

    if (e.ts >= since48) {
      const h = ymdh(e.ts);
      if (!hourly.has(h)) hourly.set(h, { hour: h, events: 0, sessions: new Set() });
      const hh = hourly.get(h); hh.events++; hh.sessions.add(e.sessionId);
    }

    if (opts.day && ymd(e.ts, tz) === opts.day) {
      let hr;
      try { hr = new Date(e.ts).toLocaleString("en-US", { timeZone: tz, hour12: false, hour: "2-digit" }); }
      catch { hr = new Date(e.ts).getUTCHours().toString().padStart(2, "0"); }
      hr = String(parseInt(hr, 10)).padStart(2, "0");
      if (!dayHours.has(hr)) dayHours.set(hr, { hour: hr, events: 0, sessions: new Set() });
      const x = dayHours.get(hr); x.events++; x.sessions.add(e.sessionId);
    }
  }

  // Per-session rollups (counted once per session, not per event).
  let activeMs = 0;
  const live = [];
  const locations = [];
  for (const s of sessions.values()) {
    inc(byDevice, s.device || "Unknown");
    inc(byOS, s.os || "Unknown");
    inc(byBrowser, s.browser || "Unknown");
    inc(byDeviceType, s.deviceType || "Unknown");
    inc(byPerson, s.name || "Anonymous");
    inc(byPage, s.page || "/");
    const geo = geoFor(s.ip);
    if (geo && geo.country) inc(byCountry, geo.country);
    if (geo && geo.city) inc(byCity, `${geo.city}${geo.countryCode ? ", " + geo.countryCode : ""}`);
    activeMs += Math.max(0, s.lastSeen - s.startedAt);

    // Best-known position for the map: precise GPS if shared, else the IP city centroid.
    const lat = s.gps ? s.gps.lat : (geo ? geo.lat : null);
    const lon = s.gps ? s.gps.lng : (geo ? geo.lon : null);
    if (typeof lat === "number" && typeof lon === "number") {
      locations.push({
        name: s.name || "Anonymous", device: s.device, deviceType: s.deviceType,
        lat, lon, source: s.gps ? "gps" : "ip",
        place: s.gps ? s.gps.place : (geo ? [geo.city, geo.country].filter(Boolean).join(", ") : null),
        lastSeen: s.lastSeen, live: now - s.lastSeen <= LIVE_MS,
      });
    }
    if (now - s.lastSeen <= LIVE_MS) {
      live.push({ sessionId: s.sessionId, name: s.name || "Anonymous", device: s.device,
        os: s.os, browser: s.browser, deviceType: s.deviceType, page: s.page,
        ip: s.ip, geo: geo ? { city: geo.city, region: geo.region, country: geo.country, countryCode: geo.countryCode, isp: geo.isp } : null,
        gps: s.gps || null,
        lastSeen: s.lastSeen, startedAt: s.startedAt, durationMs: Math.max(0, s.lastSeen - s.startedAt) });
    }
  }
  live.sort((a, b) => b.lastSeen - a.lastSeen);

  const dailyArr = [...daily.values()]
    .map((d) => ({ date: d.date, events: d.events, pageviews: d.pageviews, sessions: d.sessions.size }))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  const hourlyArr = [...hourly.values()]
    .map((h) => ({ hour: h.hour, events: h.events, sessions: h.sessions.size }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  const dayHoursArr = opts.day
    ? Array.from({ length: 24 }, (_, i) => {
        const hr = String(i).padStart(2, "0");
        const x = dayHours.get(hr);
        return { hour: hr, events: x ? x.events : 0, sessions: x ? x.sessions.size : 0 };
      })
    : null;

  const recent = events.slice(-200).reverse().map((e) => {
    const geo = geoFor(e.ip);
    return {
      ts: e.ts, type: e.type, event: e.event, name: e.name || "Anonymous",
      device: e.device, os: e.os, browser: e.browser, deviceType: e.deviceType, page: e.page,
      ip: e.ip, gps: e.gps || null,
      geo: geo ? { city: geo.city, region: geo.region, country: geo.country, countryCode: geo.countryCode } : null,
      sessionId: e.sessionId,
    };
  });

  return {
    generatedAt: now,
    tz,
    totals: {
      events: events.length,
      pageviews: byType.get("pageview") || 0,
      visitors: visitors.size,
      sessions: sessions.size,
      liveNow: live.length,
      activeMs,
      eventsByType: Object.fromEntries(byType),
    },
    live,
    locations,
    series: { daily: dailyArr, hourly: hourlyArr, dayHours: dayHoursArr },
    byDevice: topCounts(byDevice),
    byOS: topCounts(byOS),
    byBrowser: topCounts(byBrowser),
    byDeviceType: topCounts(byDeviceType),
    byPerson: topCounts(byPerson),
    byPage: topCounts(byPage),
    byCountry: topCounts(byCountry),
    byCity: topCounts(byCity),
    recent,
  };
}

// Test-only: wipe in-memory state so each test starts clean.
export function _resetAnalyticsForTest() {
  events.length = 0;
  loaded = true; // skip file load in tests
}
