// Together-mode REAL-WORLD scenario suite — all 3 cars.
//
// Drives the REAL server relay handler (handleTogether + togetherRooms, imported
// from server.js) with a faithful model of the CLIENT's request-mode decision
// (broadcast / keepalive / peek / leave) copied 1:1 from pushTogether in
// index.html. Elapsed time (tunnels, locks, restarts, TTL) is simulated by ageing
// the stored member timestamps, because the server stamps ts/seen with the real
// clock. Each scenario prints a PASS/FAIL line so the run reads as a report, and
// the whole battery runs 10x to prove there's no order/state dependence.
//
// Run:  node together.scenarios.test.mjs     (or: npm test)

import { readFileSync } from "node:fs";
process.env.PORT = "0";

const {
  handleTogether,
  togetherRooms,
  TOGETHER_TTL_MS,
} = await import("./server.js");

// ---- constants mirrored from index.html ------------------------------------
const ROOM = "nordkapp-fam-7e3a";
const STALE = 20000;            // TOGETHER_STALE_MS — no fresh fix for >20s ⇒ "signal lost"
const NAME_CAR = { arijit: "modelx", surojit: "modely_lr", dibakar: "modely_p" };
const slugId = (name) => "car-" + (NAME_CAR[String(name || "").trim().toLowerCase()] || "x");

// ---- server access helpers -------------------------------------------------
function call(body) {
  let status = 200, payload;
  const res = { status(c) { status = c; return res; }, json(j) { payload = j; return res; } };
  handleTogether({ body }, res);
  return { status, body: payload };
}
const roomMap = () => togetherRooms.get(ROOM);
const memberOf = (id) => roomMap() && roomMap().get(id);
const roomSize = () => (roomMap() ? roomMap().size : 0);
function age(id, ms) { const v = memberOf(id); if (v) { v.ts -= ms; v.seen -= ms; } } // simulate elapsed time
const triggerPrune = () => call({ room: ROOM, id: "peek-tick" });                     // prune without registering

// ---- faithful client model (mirrors pushTogether) --------------------------
class Car {
  constructor(label) { this.label = label; this.reset(); }
  reset() {
    this.togetherName = ""; this.togetherId = ""; this.myIdentity = "";
    this.userLoc = null; this.userFixAt = 0; this.visibility = "visible";
  }
  join(name) { this.togetherName = name; this.togetherId = slugId(name); this.myIdentity = name; }
  leaveLocal() { this.togetherName = ""; this.togetherId = ""; } // keeps myIdentity (device stays bound)
  fix(lat, lon, acc = 10, atMsAgo = 0) { this.userLoc = { lat, lon, acc }; this.userFixAt = Date.now() - atMsAgo; }
  loseFix() { this.userLoc = null; this.userFixAt = 0; }
  plan(now = Date.now()) { // decide the outgoing request exactly like pushTogether
    const wantShare = !!this.togetherName && this.visibility !== "hidden";
    const fixFresh = !!this.userLoc && (now - this.userFixAt) <= STALE;
    const broadcasting = wantShare && fixFresh;
    const keepalive = wantShare && !broadcasting && !!this.togetherId;
    if (broadcasting && this.userLoc) {
      const body = { room: ROOM, id: this.togetherId, name: this.togetherName, lat: this.userLoc.lat, lng: this.userLoc.lon };
      if (this.userLoc.acc != null) body.acc = this.userLoc.acc;
      return { mode: "broadcast", body };
    } else if (keepalive) {
      return { mode: "keepalive", body: { room: ROOM, id: this.togetherId, keepalive: true } };
    }
    return { mode: "peek", body: { room: ROOM, id: "peek-" + (this.togetherId || "x") } };
  }
  beat() { const { mode, body } = this.plan(); const r = call(body); return { mode, status: r.status, members: r.body.members }; }
  sendLeave() { return call({ room: ROOM, id: this.togetherId, leave: true }); }
}
const view = (members) => members.map((m) => ({ ...m, stale: Date.now() - m.ts > STALE, coarse: Number.isFinite(m.acc) && m.acc > 150 }));
const sees = (members, id) => members.some((m) => m.id === id);
const find = (members, id) => members.find((m) => m.id === id);

const arijit = new Car("Arijit"), surojit = new Car("Surojit"), dibakar = new Car("Dibakar");
const all = [arijit, surojit, dibakar];
const resetCars = () => all.forEach((c) => c.reset());

const L = {
  oslo: [59.91, 10.75], lillehammer: [61.115, 10.466], dombas: [62.075, 9.125],
  trondheim: [63.43, 10.39], moirana: [66.31, 14.14], bodo: [67.28, 14.40],
  narvik: [68.44, 17.43], tromso: [69.65, 18.96], alta: [69.97, 23.27], nordkapp: [71.17, 25.78],
};

// ---- test registry + runner ------------------------------------------------
const TESTS = [];
const def = (id, title, fn) => TESTS.push({ id, title, fn });

let passed = 0, failed = 0;
const fails = [];
const report = [];
function check(cond, msg) { if (cond) passed++; else { failed++; fails.push(msg); } }

function runBattery(capture) {
  for (const t of TESTS) {
    togetherRooms.clear();
    const before = failed;
    let note = "";
    try { note = t.fn() || ""; }
    catch (e) { failed++; fails.push(`${t.id} threw: ${e.stack || e.message}`); }
    if (capture) report.push(`${failed === before ? "PASS" : "FAIL"}  ${t.id.padEnd(4)} ${t.title}${note ? "  · " + note : ""}`);
  }
}

// =====================================================================
//  GROUP A — multiple locations & live convoy
// =====================================================================
def("A1", "All 3 cars broadcast from different locations → each sees the other two", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  surojit.join("Surojit"); surojit.fix(...L.lillehammer);
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas);
  arijit.beat(); surojit.beat(); dibakar.beat();
  const v = view(arijit.beat().members);
  check(v.length === 2, "Arijit sees exactly 2 others");
  check(sees(v, "car-modely_lr") && sees(v, "car-modely_p"), "sees Surojit + Dibakar");
  const s = find(v, "car-modely_lr");
  check(s.lat === L.lillehammer[0] && s.lng === L.lillehammer[1], "Surojit at Lillehammer");
  check(!s.stale, "convoy shown live");
  return "3 live pins, correct coordinates";
});

def("A2", "Real-time upsert: a car moves → others get the LATEST position, no duplicate", () => {
  resetCars();
  all.forEach((c, i) => { c.join(c.label); c.fix(...[L.oslo, L.lillehammer, L.dombas][i]); c.beat(); });
  dibakar.fix(...L.trondheim); dibakar.beat();
  const d = find(view(arijit.beat().members), "car-modely_p");
  check(d.lat === L.trondheim[0], "Dibakar position updated to Trondheim");
  check(roomSize() === 3, "still exactly 3 slots (upsert, not duplicate)");
  return "last-write-wins, one pin per car";
});

def("A3", "No car ever appears in its own roster (no self / double pin)", () => {
  resetCars();
  all.forEach((c, i) => { c.join(c.label); c.fix(...[L.oslo, L.lillehammer, L.dombas][i]); c.beat(); });
  check(!sees(arijit.beat().members, "car-modelx"), "Arijit excluded from own list");
  check(!sees(surojit.beat().members, "car-modely_lr"), "Surojit excluded from own list");
  check(!sees(dibakar.beat().members, "car-modely_p"), "Dibakar excluded from own list");
  return "self always filtered server-side";
});

// =====================================================================
//  GROUP B — tunnels (short / long / very long)
// =====================================================================
def("B1", "SHORT tunnel (<20s, screen on): car re-broadcasts last fix, stays LIVE", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas, 10, 8000); // last fix 8s ago
  check(dibakar.plan().mode === "broadcast", "8s-old fix still 'fresh' → broadcast (re-sends last position)");
  dibakar.beat();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  const d = find(view(arijit.beat().members), "car-modely_p");
  check(d && !d.stale, "family sees Dibakar LIVE during the short tunnel");
  return "fix <20s old keeps the car live";
});

def("B2", "LONG tunnel (screen on, >20s no fix): keepalive holds last spot, shown 'signal lost'", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", 25000);
  dibakar.fix(...L.dombas, 10, 25000);
  check(dibakar.plan().mode === "keepalive", "stale fix (>20s) → keepalive, no coordinates sent");
  dibakar.beat();
  check(memberOf("car-modely_p").lat === L.dombas[0], "last-known position preserved");
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  const d = find(view(arijit.beat().members), "car-modely_p");
  check(d && d.stale, "family shows Dibakar 'signal lost · last seen'");
  check(!!memberOf("car-modely_p"), "NOT pruned (seen kept fresh by keepalive)");
  return "kept on the map, dimmed, for the whole tunnel";
});

def("B3", "VERY LONG tunnel (screen on > 60min TTL, keepalives): never pruned", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", TOGETHER_TTL_MS + 300000);
  dibakar.fix(...L.dombas, 10, TOGETHER_TTL_MS + 300000);
  check(dibakar.plan().mode === "keepalive", "still keepalive");
  dibakar.beat();
  triggerPrune();
  check(!!memberOf("car-modely_p"), "survives past TTL because keepalive refreshed seen");
  return "screen-on keepalive defeats the 60-min backstop";
});

def("B4", "LONG tunnel with SCREEN LOCKED (JS frozen, no keepalives) > TTL → pruned", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", TOGETHER_TTL_MS + 60000);
  triggerPrune();
  check(!memberOf("car-modely_p"), "pruned after the grace window when no keepalive arrived");
  return "locked screen drops after the 60-min backstop";
});

// =====================================================================
//  GROUP C — screen lock / backgrounding (privacy)
// =====================================================================
def("C1", "Backgrounded/locked app does NOT broadcast location (privacy)", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas);
  dibakar.visibility = "hidden";
  const plan = dibakar.plan();
  check(plan.mode === "peek", "hidden → peek only");
  check(plan.body.lat === undefined && !plan.body.keepalive, "no coordinates leave the device when hidden");
  return "no location shared while backgrounded";
});

def("C2", "Auto-rejoin on UNLOCK: broadcast resumes, car reappears live", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  dibakar.visibility = "hidden"; age("car-modely_p", 30000);
  dibakar.visibility = "visible"; dibakar.fix(...L.trondheim);
  dibakar.beat();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  const d = find(view(arijit.beat().members), "car-modely_p");
  check(d && !d.stale, "Dibakar live again after unlock");
  check(d.lat === L.trondheim[0], "position is the post-unlock fix");
  return "reappears the instant the screen wakes";
});

// =====================================================================
//  GROUP D — phone / app restart
// =====================================================================
def("D1", "App restart with saved name → auto-rejoin upserts the SAME slot (no duplicate)", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  const restarted = new Car("Dibakar"); restarted.join("Dibakar"); restarted.fix(...L.trondheim); restarted.beat();
  check(roomSize() === 1, "still one Dibakar slot after restart");
  check(memberOf("car-modely_p").lat === L.trondheim[0], "slot carries the post-restart position");
  return "same id ⇒ seamless takeover of own slot";
});

def("D2", "Restart AFTER being pruned (long offline) → recreated cleanly", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", TOGETHER_TTL_MS + 60000); triggerPrune();
  check(!memberOf("car-modely_p"), "was pruned while offline");
  const restarted = new Car("Dibakar"); restarted.join("Dibakar"); restarted.fix(...L.alta); restarted.beat();
  check(!!memberOf("car-modely_p") && memberOf("car-modely_p").lat === L.alta[0], "recreated at the new position");
  return "clean re-registration, no ghost";
});

def("D3", "Fresh device / cleared storage → name picker, peek-only until a name is chosen", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo); arijit.beat();
  const fresh = new Car("?");
  check(fresh.plan().mode === "peek", "no name → peek");
  const r = fresh.beat();
  check(roomSize() === 1, "peeking device is NOT registered");
  check(sees(r.members, "car-modelx"), "but it can see the family");
  return "watch-only until you pick your name";
});

// =====================================================================
//  GROUP E — patchy / no signal
// =====================================================================
def("E1", "Patchy signal: broadcast → (stale) keepalive → (fresh) broadcast; never dropped", () => {
  resetCars();
  dibakar.join("Dibakar");
  dibakar.fix(...L.dombas); check(dibakar.beat().mode === "broadcast", "fix → broadcast");
  age("car-modely_p", 25000); dibakar.fix(...L.dombas, 10, 25000);
  check(dibakar.beat().mode === "keepalive", "fix went stale → keepalive");
  check(!!memberOf("car-modely_p"), "still on the map through the gap");
  dibakar.fix(...L.trondheim); check(dibakar.beat().mode === "broadcast", "new fix → broadcast");
  check(memberOf("car-modely_p").lat === L.trondheim[0], "snaps to the new fix");
  return "rides through intermittent coverage";
});

def("E2", "Dead zone with NO prior fix: keepalive is a no-op → car invisible until first fix", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.loseFix();
  check(dibakar.plan().mode === "keepalive", "joined but no fix → keepalive");
  dibakar.beat();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  check(!sees(arijit.beat().members, "car-modely_p"), "family can't see a car that never sent a position");
  dibakar.fix(...L.dombas); dibakar.beat();
  check(sees(arijit.beat().members, "car-modely_p"), "appears once the first fix lands");
  return "no phantom pin before the first fix";
});

def("E3", "Dead zone WITH prior fix (screen on): last-known kept, coordinates frozen", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.moirana); dibakar.beat();
  const before = { ...memberOf("car-modely_p") };
  age("car-modely_p", 40000); dibakar.fix(...L.moirana, 10, 40000);
  dibakar.beat();
  const after = memberOf("car-modely_p");
  check(after.lat === before.lat && after.lng === before.lng, "position frozen at last-known");
  check(after.ts === before.ts - 40000, "ts not advanced by keepalive");
  return "shows where it was last seen";
});

// =====================================================================
//  GROUP F — rejoin (auto / manual / after exit)
// =====================================================================
def("F1", "Auto-rejoin after a SKIPPED/failed heartbeat (no drop within TTL)", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", 7000);
  check(!!memberOf("car-modely_p"), "still present after a missed beat");
  dibakar.fix(...L.dombas); dibakar.beat();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  check(!find(view(arijit.beat().members), "car-modely_p").stale, "back to live after resume");
  return "transient failures self-heal";
});

def("F2", "MANUAL rejoin: Stop sharing (leave) then re-pick → drops then reappears", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo); arijit.beat();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  dibakar.sendLeave(); dibakar.leaveLocal();
  check(!sees(arijit.beat().members, "car-modely_p"), "family loses Dibakar on Stop sharing");
  dibakar.join("Dibakar"); dibakar.fix(...L.trondheim); dibakar.beat();
  check(sees(arijit.beat().members, "car-modely_p"), "reappears after re-picking the name");
  return "explicit stop, then clean rejoin";
});

def("F3", "Full EXIT (close HUD → leave) then reopen Together → auto-rejoin", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  dibakar.sendLeave();
  check(!memberOf("car-modely_p"), "removed on exit");
  dibakar.fix(...L.bodo); dibakar.beat();
  check(!!memberOf("car-modely_p") && memberOf("car-modely_p").lat === L.bodo[0], "auto-rejoined on reopen");
  return "exit removes immediately; reopen resumes";
});

// =====================================================================
//  GROUP G — identity / same name from another phone
// =====================================================================
def("G1", "Same name on a SECOND phone → same slot, last-write-wins, ONE pin", () => {
  resetCars();
  const phone1 = new Car("Dibakar"); phone1.join("Dibakar"); phone1.fix(...L.dombas); phone1.beat();
  const phone2 = new Car("Dibakar"); phone2.join("Dibakar"); phone2.fix(...L.trondheim); phone2.beat();
  check(roomSize() === 1, "still a single Dibakar slot (one car, one pin)");
  check(memberOf("car-modely_p").lat === L.trondheim[0], "latest writer (phone2) wins");
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  check(view(arijit.beat().members).filter((m) => m.id === "car-modely_p").length === 1, "family sees ONE Dibakar");
  return "deterministic id ⇒ no duplicate car";
});

def("G2", "Identity lock: a bound device can only pick its OWN name; occupied names lock too", () => {
  const selectable = (name, myIdentity, occupiedByOther) => {
    const bound = (myIdentity || "").trim().toLowerCase();
    const mine = !!bound && name.toLowerCase() === bound;
    const lockedNotYou = !!bound && !mine;
    const occByOther = occupiedByOther && !mine;
    return !(occByOther || lockedNotYou);
  };
  check(selectable("Dibakar", "Dibakar", false), "own name selectable");
  check(!selectable("Arijit", "Dibakar", false), "Arijit locked on Dibakar's device");
  check(!selectable("Surojit", "Dibakar", false), "Surojit locked on Dibakar's device");
  check(selectable("Arijit", "", false), "free name selectable on a fresh device");
  check(!selectable("Surojit", "", true), "a name already sharing from another phone is locked");
  return "you can never masquerade as another car";
});

def("G3", "Two DIFFERENT names from two phones → two distinct pins", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo); arijit.beat();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  check(roomSize() === 2, "two distinct slots");
  check(slugId("Arijit") !== slugId("Dibakar"), "distinct ids");
  return "normal multi-car convoy";
});

// =====================================================================
//  GROUP H — leaving
// =====================================================================
def("H1", "Leave WITH INTENT (Stop sharing) → others see the drop in the same tick", () => {
  resetCars();
  all.forEach((c, i) => { c.join(c.label); c.fix(...[L.oslo, L.lillehammer, L.dombas][i]); c.beat(); });
  dibakar.sendLeave();
  check(!sees(arijit.beat().members, "car-modely_p"), "Dibakar gone immediately, no TTL wait");
  return "instant, intent-driven removal";
});

def("H2", "Leave on app CLOSE (pagehide) → same immediate removal", () => {
  resetCars();
  surojit.join("Surojit"); surojit.fix(...L.lillehammer); surojit.beat();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  dibakar.sendLeave();
  check(!sees(surojit.beat().members, "car-modely_p"), "removed on clean close");
  return "clean close drops the car at once";
});

def("H3", "All cars leave → room is deleted (no lingering state)", () => {
  resetCars();
  all.forEach((c, i) => { c.join(c.label); c.fix(...[L.oslo, L.lillehammer, L.dombas][i]); c.beat(); });
  all.forEach((c) => c.sendLeave());
  check(!togetherRooms.has(ROOM), "empty room removed");
  return "no ghosts left behind";
});

// =====================================================================
//  GROUP I — edge cases & robustness
// =====================================================================
def("I1", "A peeking viewer never registers and never appears to the family", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo); arijit.beat();
  const viewer = new Car("?"); viewer.beat();
  check(roomSize() === 1, "viewer not stored");
  check(!sees(arijit.beat().members, "peek-x"), "viewer invisible to others");
  return "read-only viewers stay invisible";
});

def("I2", "Coarse GPS fix (>150m) relayed so others can flag a ± radius", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas, 1200); dibakar.beat();
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  const d = find(view(arijit.beat().members), "car-modely_p");
  check(d.acc === 1200, "accuracy relayed");
  check(d.coarse, "client flags it as a coarse fix");
  return "imprecise fixes are labelled, not hidden";
});

def("I3", "Rapid out-of-order upserts → final position wins, slot count stable", () => {
  resetCars();
  dibakar.join("Dibakar");
  for (const p of [L.oslo, L.lillehammer, L.dombas, L.trondheim, L.moirana]) { dibakar.fix(...p); dibakar.beat(); }
  check(roomSize() === 1, "still one slot after 5 quick updates");
  check(memberOf("car-modely_p").lat === L.moirana[0], "final position is the last write");
  return "no slot churn under rapid updates";
});

def("I4", "Regression guard: a transient 429/non-OK no longer EJECTS the user", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  check(!/r\.status\s*===\s*429/.test(html), "buggy 429→room-full ejection removed from pushTogether");
  check(/must NOT eject the user/.test(html), "non-OK now skips the tick and retries");
  check(html.includes("togetherBusy latched"), "hung-request timeout (AbortController) added");
  return "rate-limit blip keeps your name & roster";
});

def("I5", "Stale 'signal lost' clears the instant a fresh fix is broadcast", () => {
  resetCars();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_p", 30000);
  arijit.join("Arijit"); arijit.fix(...L.oslo);
  check(find(view(arijit.beat().members), "car-modely_p").stale, "shown signal-lost while stale");
  dibakar.fix(...L.dombas); dibakar.beat();
  check(!find(view(arijit.beat().members), "car-modely_p").stale, "back to live");
  return "recovers cleanly from a signal gap";
});

def("I6", "Mixed fleet: one live, one in-tunnel, one left — family view is correct", () => {
  resetCars();
  arijit.join("Arijit"); arijit.fix(...L.oslo); arijit.beat();
  surojit.join("Surojit"); surojit.fix(...L.lillehammer); surojit.beat();
  dibakar.join("Dibakar"); dibakar.fix(...L.dombas); dibakar.beat();
  age("car-modely_lr", 30000);
  dibakar.sendLeave();
  const v = view(arijit.beat().members);
  check(find(v, "car-modely_lr") && find(v, "car-modely_lr").stale, "Surojit shown signal-lost");
  check(!sees(v, "car-modely_p"), "Dibakar absent (left)");
  check(roomSize() === 2, "two slots remain (Arijit + Surojit)");
  return "live + stale + gone all rendered correctly";
});

// ---- run: capture report on pass 1, then 9 more passes for determinism ------
const ITERATIONS = 10;
runBattery(true);
const iter1Failed = failed;
for (let it = 2; it <= ITERATIONS; it++) runBattery(false);

console.log("Together-mode — real-world scenario report (all 3 cars: Arijit · Surojit · Dibakar)\n");
console.log(report.join("\n"));
console.log(`\nScenarios: ${TESTS.length} · ran ${ITERATIONS}x · total assertions: ${passed + failed}`);
console.log(`Iteration 1: ${TESTS.length - report.filter((r) => r.startsWith("FAIL")).length}/${TESTS.length} scenarios passed, ${iter1Failed} assertion failure(s)`);
console.log(`Determinism: ${failed === iter1Failed * ITERATIONS ? "STABLE across all 10 passes (no flakiness)" : "INCONSISTENT — flaky scenario detected"}`);
if (fails.length) {
  console.log("\nFailures:");
  [...new Set(fails)].slice(0, 40).forEach((f) => console.log("  ✗ " + f));
}
process.exit(iter1Failed ? 1 : 0);
