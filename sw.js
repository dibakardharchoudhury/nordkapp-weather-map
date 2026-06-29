// Nordkapp Roadtrip — service worker.
// Goal: the app keeps working in the long no-signal stretches up north. We cache
// the app shell + map tiles + the last weather/POI responses, so a cold or
// offline launch still shows the map, your stops, and the most recent data.
//
// Strategy per request type:
//   • App shell (html, manifest, icons, Leaflet)  -> cache-first
//   • Map tiles (OpenStreetMap)                    -> cache-first (grows as you pan)
//   • Data APIs (MET weather, Photon/Nominatim)    -> network-first, fall back to cache
//   • Chat proxy POSTs                             -> never touched (always live)
const VERSION = "v7";
const SHELL_CACHE = `nordkapp-shell-${VERSION}`;
const TILE_CACHE = `nordkapp-tiles-${VERSION}`;
const DATA_CACHE = `nordkapp-data-${VERSION}`;
const TILE_MAX = 600; // soft cap so the tile cache can't grow without bound

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.endsWith(`-${VERSION}`)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

const isTile = (url) => /tile\.openstreetmap\.org/.test(url);
const isData = (url) => /api\.met\.no|photon\.komoot\.io|nominatim\.openstreetmap\.org|overpass/.test(url);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;          // chat POSTs and other writes stay live
  const url = req.url;
  if (isTile(url)) { event.respondWith(cacheFirst(req, TILE_CACHE, TILE_MAX)); return; }
  if (isData(url)) { event.respondWith(networkFirst(req, DATA_CACHE)); return; }
  event.respondWith(cacheFirst(req, SHELL_CACHE)); // shell + Leaflet
});

async function cacheFirst(req, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    if (resp && (resp.ok || resp.type === "opaque")) {
      // Cache in the background so we never block the tile from painting.
      const copy = resp.clone();
      cache.put(req, copy).then(() => { if (cap) maybeTrim(cacheName, cap); });
    }
    return resp;
  } catch (err) {
    const fallback = await cache.match(req);
    if (fallback) return fallback;
    throw err;
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// Drop the oldest entries once a cache exceeds its cap (rough FIFO).
// Enumerating the cache is expensive, so during rapid panning/zooming we only
// trim occasionally (and never on the path that paints a tile).
let trimming = false;
async function maybeTrim(cacheName, max) {
  if (trimming || Math.random() > 0.1) return; // ~1 in 10 puts, one at a time
  trimming = true;
  try { await trim(cacheName, max); } finally { trimming = false; }
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
