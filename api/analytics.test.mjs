// Analytics module tests — pure aggregation, no network and no disk.
// We feed beacons through recordAnalytics() (with private/loopback IPs so the geo
// lookup is skipped) and assert the summary aggregates correctly.
//
// Run:  node analytics.test.mjs   (or: npm test)

process.env.NA_ANALYTICS_NOFILE = "1"; // never touch the filesystem in tests
const { recordAnalytics, analyticsSummary, parseUA, _resetAnalyticsForTest } = await import("./analytics.js");

let passed = 0, failed = 0;
const fails = [];
const check = (cond, msg) => { if (cond) passed++; else { failed++; fails.push(msg); } };

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
  ipadSafari: "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1",
};

async function run(iteration) {
  _resetAnalyticsForTest();
  const t0 = Date.now();

  // parseUA correctness
  check(parseUA(UA.androidChrome).os === "Android" && parseUA(UA.androidChrome).browser === "Chrome" && parseUA(UA.androidChrome).deviceType === "Mobile", "Android Chrome parsed");
  check(parseUA(UA.iphoneSafari).os === "iOS" && parseUA(UA.iphoneSafari).browser === "Safari" && parseUA(UA.iphoneSafari).deviceType === "Mobile", "iPhone Safari parsed");
  check(parseUA(UA.winEdge).os === "Windows" && parseUA(UA.winEdge).browser === "Edge" && parseUA(UA.winEdge).deviceType === "Desktop", "Windows Edge parsed");
  check(parseUA(UA.macFirefox).os === "macOS" && parseUA(UA.macFirefox).browser === "Firefox", "macOS Firefox parsed");
  check(parseUA(UA.ipadSafari).deviceType === "Tablet", "iPad classed as Tablet");

  // Three devices = three sessions, three people.
  await recordAnalytics({ type: "pageview", visitorId: "dev-arijit", sessionId: "s-arijit-1", name: "Arijit", path: "/", tz: "Europe/Oslo" }, UA.winEdge, "203.0.113.10");
  await recordAnalytics({ type: "pageview", visitorId: "dev-surojit", sessionId: "s-surojit-1", name: "Surojit", path: "/", tz: "Europe/Oslo" }, UA.iphoneSafari, "198.51.100.20");
  await recordAnalytics({ type: "pageview", visitorId: "dev-dibakar", sessionId: "s-dibakar-1", name: "Dibakar", device: "Dibakar's Pixel", path: "/", lat: 59.7654, lng: 10.088, acc: 12, place: "Granittveien, Solbergelva" }, UA.androidChrome, "203.0.113.30");
  // Heartbeats keep Dibakar live and extend the session (client always re-sends its device label).
  await recordAnalytics({ type: "heartbeat", visitorId: "dev-dibakar", sessionId: "s-dibakar-1", name: "Dibakar", device: "Dibakar's Pixel", lat: 59.77, lng: 10.09 }, UA.androidChrome, "203.0.113.30");
  await recordAnalytics({ type: "event", event: "together_join", visitorId: "dev-dibakar", sessionId: "s-dibakar-1", name: "Dibakar", device: "Dibakar's Pixel", path: "/" }, UA.androidChrome, "203.0.113.30");
  // Visit to the analytics page from one device.
  await recordAnalytics({ type: "pageview", visitorId: "dev-arijit", sessionId: "s-arijit-1", name: "Arijit", path: "/analytics" }, UA.winEdge, "203.0.113.10");

  const sum = analyticsSummary({ tz: "Europe/Oslo" });

  check(sum.totals.sessions === 3, "3 sessions");
  check(sum.totals.visitors === 3, "3 unique devices/visitors");
  check(sum.totals.events === 6, "6 events total");
  check(sum.totals.pageviews === 4, "4 pageviews");
  check(sum.totals.eventsByType.event === 1, "1 custom event");
  check(sum.totals.liveNow === 3, "all 3 sessions live (just now)");

  // People breakdown
  const ppl = Object.fromEntries(sum.byPerson.map((x) => [x.key, x.count]));
  check(ppl.Arijit === 1 && ppl.Surojit === 1 && ppl.Dibakar === 1, "byPerson has all three");

  // Objective per-IP rollup (the reliable identity — independent of self-picked name)
  const ipMap = Object.fromEntries(sum.byIp.map((x) => [x.ip, x]));
  check(sum.byIp.length === 3, "byIp has 3 unique IPs");
  check(ipMap["203.0.113.30"] && ipMap["203.0.113.30"].sessions === 1 && ipMap["203.0.113.30"].events === 3, "Dibakar IP rolled up: 1 session, 3 events");
  check(ipMap["203.0.113.30"].names.includes("Dibakar") && ipMap["203.0.113.30"].deviceTypes.includes("Mobile"), "IP row carries name(s) + device type");
  check(ipMap["203.0.113.10"] && ipMap["203.0.113.10"].events === 2, "Arijit IP has 2 events");
  check(ipMap["203.0.113.30"].live === true, "recently-seen IP flagged live");
  check(sum.byIp.every((r) => typeof r.firstSeen === "number" && typeof r.lastSeen === "number" && r.lastSeen >= r.firstSeen), "byIp rows carry valid timestamps");

  // Device-type breakdown: 2 Mobile (iPhone + Android), 1 Desktop (Win)
  const dt = Object.fromEntries(sum.byDeviceType.map((x) => [x.key, x.count]));
  check(dt.Mobile === 2 && dt.Desktop === 1, "device types split 2 mobile / 1 desktop");

  // Friendly device name override is respected
  check(sum.byDevice.some((d) => d.key === "Dibakar's Pixel"), "custom device name kept");
  check(sum.byDevice.some((d) => d.key === "Windows · Edge"), "default device label derived");

  // GPS surfaces in locations (precise) for Dibakar; live row carries it
  const dibLoc = sum.locations.find((l) => l.name === "Dibakar");
  check(dibLoc && dibLoc.source === "gps" && Math.abs(dibLoc.lat - 59.77) < 0.001, "Dibakar GPS location captured (latest fix)");
  const dibLive = sum.live.find((l) => l.name === "Dibakar");
  check(dibLive && dibLive.gps && dibLive.ip === "203.0.113.30", "live row carries GPS + IP");

  // Recent feed newest-first, includes the analytics pageview and the IP
  check(sum.recent[0].page === "/analytics" && sum.recent[0].name === "Arijit", "recent is newest-first");
  check(sum.recent.every((r) => typeof r.ip === "string"), "recent rows carry IP");

  // Daily series has one bucket (all today) with 3 sessions
  check(sum.series.daily.length >= 1, "daily series present");
  const today = sum.series.daily[sum.series.daily.length - 1];
  check(today.sessions === 3 && today.pageviews === 4, "today bucket: 3 sessions, 4 pageviews");

  // Drill-down: hourly buckets for today total to the day's events
  const drill = analyticsSummary({ tz: "Europe/Oslo", day: today.date });
  check(Array.isArray(drill.series.dayHours) && drill.series.dayHours.length === 24, "drill-down returns 24 hourly buckets");
  const drillEvents = drill.series.dayHours.reduce((a, h) => a + h.events, 0);
  check(drillEvents === 6, "hourly drill-down sums to all 6 events");

  // Invalid beacons are rejected
  const bad1 = await recordAnalytics({ type: "nope", visitorId: "x", sessionId: "y" }, UA.winEdge, "203.0.113.10");
  const bad2 = await recordAnalytics({ type: "pageview", sessionId: "y" }, UA.winEdge, "203.0.113.10"); // no visitorId
  check(bad1 === null && bad2 === null, "invalid beacons rejected");
  check(analyticsSummary().totals.events === 6, "rejected beacons not stored");

  return Date.now() - t0;
}

const ITER = 10;
let firstFail = 0;
for (let i = 1; i <= ITER; i++) {
  const before = failed;
  await run(i);
  if (i === 1) firstFail = failed;
  else if (failed !== before + (firstFail)) { /* determinism checked below */ }
}

console.log(`Analytics module — ${ITER}x`);
console.log(`Assertions passed: ${passed}, failed: ${failed}`);
if (fails.length) {
  console.log("\nFailures:");
  [...new Set(fails)].slice(0, 30).forEach((f) => console.log("  ✗ " + f));
}
console.log(`Determinism: ${failed === firstFail * ITER ? "STABLE" : "INCONSISTENT"}`);
process.exit(firstFail ? 1 : 0);
