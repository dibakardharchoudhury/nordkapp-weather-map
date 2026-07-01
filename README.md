# Nordkapp Roadtrip · Live Weather Map

An interactive map of a southern‑Norway → Nordkapp road trip. Every stop is plotted from a live Google My Maps, with the MET Norway (Yr) forecast for the day you'll be there, nearby food/shops/fuel, an AI trip copilot, and a live family‑location mode. Single self‑contained `index.html` — **no build step, no client API keys**.

**Live:** <https://dibakardharchoudhury.github.io/nordkapp-weather-map/>

## Features

- **Map** — Leaflet with marker **clustering** (156 stops stay snappy even on a throttled phone) and per‑day colored routes. Stops are **numbered in driving order** (badge on each pin + "Stop N of M" in the popup/panel).
- **Weather** — MET Norway / Yr only: live "now" + daily forecast (~9‑day horizon); beyond that, a labeled seasonal normal (never a fabricated forecast).
- **Nearby POIs** — food, groceries and fuel with opening hours, via Photon + Nominatim (OpenStreetMap), keyless. 5 km radius, auto‑expanding to 25 km when nothing is close.
- **AI copilot** — a chat panel and one‑tap "Today's Summary" per day, grounded strictly in your trip data (weather, hours, distances, chargers). Server‑enforced guardrails.
- **Together mode** — opt‑in live family location relay (pick a name, share your pin, see the convoy).
- **PWA** — installable, works offline (cached shell + tiles + last data), with an in‑app update prompt.
- **Analytics** — a private traffic dashboard (`analytics.html`).

## Architecture

| Part | What | Where |
| ---- | ---- | ----- |
| Front end | One static page, vanilla JS | `index.html` (+ `analytics.html`, `sw.js`, `manifest.webmanifest`) |
| Trip data | Google My Maps KML → days/stops | `MAP_IDS` in `index.html`; fetched via CORS proxies, with a baked‑in offline fallback |
| Weather | MET Norway `locationforecast` | called directly from the browser |
| POIs | Photon (discover) + Nominatim (hours) | called directly from the browser |
| Backend | Keyless Express proxy: AI chat, Together relay, analytics ingest, server‑side trip context | `api/` on Azure App Service |

The backend authenticates to Azure OpenAI with its **managed identity** (no keys anywhere; grounding + system prompt are enforced server‑side).

## Run locally

```powershell
# from the repo root — any static server works
python -m http.server 8765
# open http://localhost:8765/index.html
```

Map, stops, weather and POIs work locally. Chat / Together / analytics call the hosted proxy, which only allows the deployed origin — those features are expected to be CORS‑blocked on `localhost` (test them on the live site).

Backend (optional, to run the proxy yourself):

```powershell
cd api
npm install
az login                 # DefaultAzureCredential needs a signed‑in identity with the AOAI role
$env:AOAI_ENDPOINT   = "https://<your-aoai>.services.ai.azure.com"
$env:AOAI_DEPLOYMENT = "model-router"
node server.js           # GET /health, POST /api/chat, /api/together, /api/analytics
```

## Configure

Edit these constants at the top of `index.html`:

- `TRIP_START` — Day 1 date; every later day is +1 calendar day.
- `MAP_IDS` — the Google My Maps IDs to read (concatenated in order). Add/move/rename stops in Google My Maps and they appear on next load; day folders may embed distance/time (e.g. `Day 2 - … - 7.5 Hrs, 524 KMs`).
- `CHAT_PROXY_URL` / `ANALYTICS_URL` — your deployed proxy base.

Backend App Service settings: `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT`, `ALLOWED_ORIGINS` (comma‑separated), `ANALYTICS_KEY`.

## Deploy

**Front end (GitHub Pages, served from repo root):**

1. Bump the build number to the **same `vNN` in all four places** (this drives the update prompt on other devices):
   - `index.html` → `APP_VERSION`
   - `sw.js` → `VERSION`
   - `version.json`
   - `analytics.html` → `NA_BUILD`
2. `git push` to `main`. `_config.yml` keeps `api/` and `*.ps1` out of the published site.

**Backend (Azure App Service):**

```powershell
cd api
pwsh -NoProfile -File .\provision.ps1   # one‑time: infra + managed‑identity RBAC
pwsh -NoProfile -File .\push.ps1         # rebuild zip + deploy
```

## Analytics dashboard

Open `analytics.html#key=<ANALYTICS_KEY>` (the key is read once, then stored in `localStorage` and stripped from the URL). Shows live visitors, sessions, devices, geos and a day→hour drill‑down. Rotate the key with `az webapp config appsettings set … --settings ANALYTICS_KEY=<new>`.

## Testing

**Backend (automated):**

```powershell
cd api
npm test    # Together relay + real‑world scenarios + analytics — ~1,750 assertions, run 10×
```

**Front‑end (manual E2E checklist):**

1. **Map is snappy** — pan/zoom the whole‑trip overview; no lag (stops cluster into count bubbles, expanding as you zoom in).
2. **Numbering** — zoom into a day; pins show 1,2,3… in driving order; a stop's popup/panel reads "Stop N of M".
3. **Stop details** — click a pin: locality, drive‑remaining, MET now + forecast (or seasonal normal), and food/shops/fuel populate.
4. **AI** — ask the copilot a grounded question (e.g. "which day is wettest?"); open a day's "Today's Summary".
5. **Together** — enable, pick a name, confirm your pin shares; exit to stop.
6. **PWA** — the version badge reads the current build; after a deploy, other devices show an update prompt.

## Tech notes

- Keyless by design: no secrets in the client or the repo; the proxy uses managed identity for Azure OpenAI.
- Weather is MET‑only on purpose — no second, less‑reliable source is ever substituted for a forecast.
- Untrusted strings (KML/OSM names, hours, chat output) are HTML‑escaped before rendering.
