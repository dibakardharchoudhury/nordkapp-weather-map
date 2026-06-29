// Server-side trip-context cache for the Nordkapp Roadtrip copilot.
//
// Builds ONE canonical trip context (stops + daily drive + weather + nearby POIs)
// shared by every user/session, so the copilot never depends on whether a given
// browser had finished loading. Strategy: lazy + stale-while-revalidate.
//   • Trip + POI : 7-day TTL  (quasi-static — Google My Maps + OSM POIs)
//   • Weather    : 15-min TTL (MET Norway / Yr.no — time-sensitive)
// Each layer serves whatever is cached instantly; if older than its TTL a single
// background refresh is kicked off and the next caller gets the fresh copy.

const MAP_IDS = [
  "1abBHiINlwR3S_ad8quDw17Pqgj0nBmw", // Part 1 — south → Nordkapp
  "1J8n9Rq_fXdpNRs0K59kSWx9CX4yilkw", // Part 2 — remaining / return leg
];
const kmlUrlFor = (mid) => `https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`;
const KML_PROXIES = [
  (u) => u,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
];
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const NEAR_KM = 5, FAR_KM = 25;

const TRIP_POI_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const WEATHER_TTL_MS = 15 * 60 * 1000;           // 15 minutes
const UA = "NordkappRoadtrip/1.0 github.com/dibakardharchoudhury/nordkapp-weather-map";

// ---- tiny fetch helpers ---------------------------------------------------
async function fetchTimed(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, init || {}));
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r;
  } finally { clearTimeout(t); }
}
function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---- KML → days/stops -----------------------------------------------------
function parseDayMeta(name) {
  name = name || "";
  const m = name.match(/day\s*\d+/i);
  const label = m ? m[0].replace(/day/i, "Day").replace(/\s+/, " ") : (name.trim() || "Day");
  const hm = name.match(/([\d.]+)\s*h(?:rs?|ours?)?(?:\s*([\d.]+)\s*m(?:ins?|inutes?)?)?/i);
  const km = name.match(/([\d.,]+)\s*k\s*ms?\b/i);
  const parts = [];
  if (hm) { const hrs = parseFloat(hm[1]) + (hm[2] ? parseFloat(hm[2]) / 60 : 0); parts.push((Math.round(hrs * 100) / 100).toString().replace(/\.0+$/, "") + " hrs"); }
  if (km) parts.push(km[1].replace(/[, ]/g, "") + " km");
  return { label, meta: parts.join(" \u00b7 ") };
}
function inferType(name, idx, dayIdx, count) {
  const n = (name || "").toLowerCase();
  if (/supercharger|charging|charge\b|ev charg/.test(n)) return "charger";
  if (dayIdx === 0 && idx === 0) return "home";
  if (/\bhome\b/.test(n)) return "home";
  if (/camping|camp\b|hotel|motel|cabin|hytte|lodge|guest ?house|hostel|overnight/.test(n)) return "stay";
  if (idx === count - 1) return "stay";
  return "sight";
}
async function fetchKml(mid) {
  let lastErr;
  const fresh = `${kmlUrlFor(mid)}&_=${Date.now()}`;
  for (const wrap of KML_PROXIES) {
    try {
      const r = await fetchTimed(wrap(fresh), { cache: "no-store" }, 12000);
      const t = await r.text();
      if (!/<kml|<Document/i.test(t)) throw new Error("Not KML");
      return t;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("KML unavailable");
}
// Regex KML parse (no DOM in Node): grab folders, their names, and point placemarks.
function parseKmlToTrip(xml) {
  const blocks = [];
  const folderRe = /<Folder\b[\s\S]*?<\/Folder>/gi;
  let fm;
  while ((fm = folderRe.exec(xml))) blocks.push(fm[0]);
  const groups = blocks.length ? blocks : [xml];
  const days = [];
  for (const g of groups) {
    const nameM = g.match(/<name>([\s\S]*?)<\/name>/i);
    const { label, meta } = parseDayMeta(nameM ? nameM[1] : "Day");
    const stops = [];
    const pmRe = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
    let pm;
    while ((pm = pmRe.exec(g))) {
      const blk = pm[0];
      const coordM = blk.match(/<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
      if (!coordM) continue;
      const first = coordM[1].trim().split(/\s+/)[0];
      const [lon, lat] = first.split(",").map(Number);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const nm = blk.match(/<name>([\s\S]*?)<\/name>/i);
      stops.push({ name: (nm ? nm[1] : "Stop").trim() || "Stop", lat, lon });
    }
    if (stops.length) days.push({ label, meta, stops });
  }
  if (!days.length) throw new Error("No stops in KML");
  days.forEach((d, di) => d.stops.forEach((s, si) => { s.type = inferType(s.name, si, di, d.stops.length); }));
  return days;
}
async function buildTrip() {
  const merged = [];
  const settled = await Promise.allSettled(MAP_IDS.map(async (m) => parseKmlToTrip(await fetchKml(m))));
  settled.forEach((r) => { if (r.status === "fulfilled") merged.push(...r.value); });
  if (!merged.length) throw new Error("No live stops from any map");
  return merged;
}

// ---- POIs (Overpass, server-side, sequential & gentle) --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function overpassQuery(lat, lon) {
  return `[out:json][timeout:15];(` +
    `nwr(around:25000,${lat},${lon})[amenity~"^(fast_food|restaurant|cafe)$"][name];` +
    `nwr(around:25000,${lat},${lon})[shop~"^(supermarket|convenience|greengrocer|general)$"][name];` +
    `nwr(around:25000,${lat},${lon})[amenity=fuel][name];` +
    `);out tags center 60;`;
}
function osmCoord(e) {
  if (e.lat != null && e.lon != null) return [e.lat, e.lon];
  if (e.center) return [e.center.lat, e.center.lon];
  return null;
}
function withinOrExpand(items) {
  const near = items.filter((x) => x.dist <= NEAR_KM);
  return near.length ? near : items.filter((x) => x.dist <= FAR_KM);
}
async function overpass(lat, lon) {
  const body = "data=" + encodeURIComponent(overpassQuery(lat, lon));
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetchTimed(ep, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA } }, 9000);
      const j = await r.json();
      if (j && Array.isArray(j.elements)) return j;
    } catch { /* next mirror */ }
  }
  return { elements: [] };
}
function poiFor(stop, data) {
  const FOOD = ["fast_food", "restaurant", "cafe"], SHOP = ["supermarket", "convenience", "greengrocer", "general"];
  const food = [], shops = [], fuel = [];
  for (const e of data.elements || []) {
    const t = e.tags || {}; if (!t.name) continue;
    const c = osmCoord(e); if (!c) continue;
    const d = distKm(stop.lat, stop.lon, c[0], c[1]);
    if (FOOD.includes(t.amenity)) food.push({ name: t.name, hours: t.opening_hours || "", dist: d });
    else if (SHOP.includes(t.shop)) shops.push({ name: t.name, hours: t.opening_hours || "", dist: d });
    else if (t.amenity === "fuel") fuel.push({ name: t.name, hours: t.opening_hours || "", dist: d });
  }
  const pick = (a) => withinOrExpand(a).sort((x, y) => x.dist - y.dist).slice(0, 4)
    .map((x) => x.name + (x.hours ? ` (${x.hours})` : ""));
  return { food: pick(food), shops: pick(shops), fuel: pick(fuel) };
}

// ---- Weather (MET Norway) -------------------------------------------------
const fmt = (n) => (n == null ? "?" : Math.round(n));
async function metDaily(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const r = await fetchTimed(url, { headers: { Accept: "application/json", "User-Agent": UA } }, 9000);
  const j = await r.json();
  const ts = j?.properties?.timeseries;
  if (!Array.isArray(ts) || !ts.length) throw new Error("MET empty");
  const osloDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Oslo" });
  const days = {};
  for (const e of ts) {
    const date = osloDate(e.time);
    const D = days[date] || (days[date] = { tmin: Infinity, tmax: -Infinity, wind: 0, psum: 0, pprob: null });
    const inst = e.data?.instant?.details || {};
    if (typeof inst.air_temperature === "number") { D.tmin = Math.min(D.tmin, inst.air_temperature); D.tmax = Math.max(D.tmax, inst.air_temperature); }
    if (typeof inst.wind_speed === "number") D.wind = Math.max(D.wind, inst.wind_speed * 3.6);
    const block = e.data?.next_1_hours || e.data?.next_6_hours;
    if (block?.details?.precipitation_amount != null) D.psum += block.details.precipitation_amount;
    if (block?.details?.probability_of_precipitation != null) D.pprob = Math.max(D.pprob || 0, block.details.probability_of_precipitation);
  }
  const byDate = {};
  for (const date of Object.keys(days)) { const D = days[date]; byDate[date] = { tmax: isFinite(D.tmax) ? D.tmax : null, tmin: isFinite(D.tmin) ? D.tmin : null, wind: D.wind || null, pprob: D.pprob }; }
  const fi = ts[0].data?.instant?.details || {};
  return { byDate, now: { temp: typeof fi.air_temperature === "number" ? fi.air_temperature : null, wind: typeof fi.wind_speed === "number" ? fi.wind_speed * 3.6 : null } };
}

// ---- caches with stale-while-revalidate -----------------------------------
let tripCache = { data: null, ts: 0, building: false };
let wxCache = { data: null, ts: 0, building: false };

async function buildTripPoi() {
  const days = await buildTrip();
  // POI enrichment in the background — do NOT gate readiness on it.
  (async () => {
    for (const d of days) {
      for (const s of d.stops) {
        try { s.poi = poiFor(s, await overpass(s.lat, s.lon)); } catch { s.poi = null; }
        await sleep(1200); // gentle on shared Overpass mirrors
      }
    }
  })();
  return days;
}
function refreshTrip() {
  if (tripCache.building) return;
  tripCache.building = true;
  buildTripPoi().then((d) => { tripCache.data = d; tripCache.ts = Date.now(); }).catch((e) => console.error("trip build:", e?.message)).finally(() => { tripCache.building = false; });
}
async function buildWeather(days) {
  const pts = new Map();
  days.forEach((d) => d.stops.forEach((s) => pts.set(s.lat.toFixed(4) + "," + s.lon.toFixed(4), s)));
  const wx = {};
  for (const [k, s] of pts) { try { wx[k] = await metDaily(s.lat, s.lon); } catch { wx[k] = null; } await sleep(150); }
  return wx;
}
function refreshWeather() {
  if (wxCache.building || !tripCache.data) return;
  wxCache.building = true;
  buildWeather(tripCache.data).then((w) => { wxCache.data = w; wxCache.ts = Date.now(); }).catch((e) => console.error("wx build:", e?.message)).finally(() => { wxCache.building = false; });
}

// Public: return the merged context as a compact JSON; never blocks on staleness.
export async function getTripContext() {
  const tripStale = !tripCache.data || Date.now() - tripCache.ts > TRIP_POI_TTL_MS;
  if (tripStale) refreshTrip();
  if (!tripCache.data) return null; // warming up — caller falls back to client context
  const wxStale = !wxCache.data || Date.now() - wxCache.ts > WEATHER_TTL_MS;
  if (wxStale) refreshWeather();
  const wx = wxCache.data || {};
  const days = tripCache.data.map((d) => ({
    day: d.label, drive: d.meta || null,
    stops: d.stops.map((s) => {
      const k = s.lat.toFixed(4) + "," + s.lon.toFixed(4);
      const w = wx[k];
      const o = { name: s.name, type: s.type, coords: k };
      if (w?.now) o.weatherNow = `${fmt(w.now.temp)}\u00b0C`;
      if (w?.byDate && Object.keys(w.byDate).length) o.forecastByDate = w.byDate;
      if (s.poi) { if (s.poi.food.length) o.food = s.poi.food; if (s.poi.shops.length) o.groceries = s.poi.shops; if (s.poi.fuel.length) o.fuel = s.poi.fuel; }
      return o;
    }),
  }));
  return { trip: "Nordkapp Roadtrip — southern Norway up to Nordkapp", startDate: "2026-07-04", today: new Date().toISOString().slice(0, 10), cachedAt: tripCache.ts, weatherAt: wxCache.ts, days };
}
