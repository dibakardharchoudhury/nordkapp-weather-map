// Together-mode relay test harness.
//
// Exercises the in-memory relay handler (POST /api/together) directly via mock
// req/res objects — no network, no rate limiter, deterministic. State is cleared
// between scenarios and the full suite runs N iterations to catch any order- or
// state-leak dependence. Run:  node together.test.mjs
//
// PORT=0 makes the imported server bind an ephemeral port harmlessly.
process.env.PORT = "0";

const {
  handleTogether,
  togetherRooms,
  pruneTogether,
  cleanMemberName,
  TOGETHER_TTL_MS,
  TOGETHER_MAX_MEMBERS,
} = await import("./server.js");

const ROOM = "nordkapp-fam-7e3a";

// ---- tiny assert framework -------------------------------------------------
let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; fails.push(msg); }
}
const eq = (a, b, msg) => ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// Invoke the real handler with a mock req/res and return { status, body }.
function call(body) {
  let status = 200, payload;
  const res = {
    status(c) { status = c; return res; },
    json(j) { payload = j; return res; },
  };
  handleTogether({ body }, res);
  return { status, body: payload };
}
const reset = () => togetherRooms.clear();
const roomMap = () => togetherRooms.get(ROOM);
const memberOf = (id) => roomMap() && roomMap().get(id);

// Fleet fixtures (the three real cars).
const A = { room: ROOM, id: "car-modelx", name: "Arijit", lat: 59.91, lng: 10.75 };
const B = { room: ROOM, id: "car-modely_lr", name: "Surojit", lat: 60.39, lng: 5.32 };
const D = { room: ROOM, id: "car-modely_p", name: "Dibakar", lat: 63.43, lng: 10.39 };

// ---- scenarios -------------------------------------------------------------
const scenarios = {
  "S1 validation: missing room/id -> 400": () => {
    reset();
    eq(call({}).status, 400, "no room/id");
    eq(call({ room: ROOM }).status, 400, "no id");
    eq(call({ id: "car-modelx" }).status, 400, "no room");
    eq(call({ room: "   ", id: "  " }).status, 400, "blank room/id after sanitise");
  },

  "S2 single broadcast registers; self excluded; serverTime present": () => {
    reset();
    const r = call(A);
    eq(r.status, 200, "status");
    eq(r.body.ok, true, "ok");
    eq(r.body.members.length, 0, "no other members yet");
    eq(typeof r.body.serverTime, "number", "serverTime is a number");
    eq(roomMap().size, 1, "one member stored");
  },

  "S3 three cars each see the other two with coords/name/acc": () => {
    reset();
    call({ ...A, acc: 12 }); call(B); call(D);
    const r = call({ ...A, acc: 12 });
    const ids = r.body.members.map((m) => m.id).sort();
    eq(JSON.stringify(ids), JSON.stringify(["car-modely_lr", "car-modely_p"]), "A sees B and D only");
    ok(!ids.includes("car-modelx"), "A never sees itself");
    const surojit = r.body.members.find((m) => m.id === "car-modely_lr");
    eq(surojit.name, "Surojit", "name relayed");
    eq(surojit.lat, B.lat, "lat relayed");
    eq(surojit.lng, B.lng, "lng relayed");
  },

  "S4 peek reads others without registering the peeker": () => {
    reset();
    call(A);
    const r = call({ room: ROOM, id: "peek-x" });
    eq(r.body.members.length, 1, "peeker sees A");
    eq(r.body.members[0].id, "car-modelx", "sees A");
    eq(roomMap().size, 1, "peeker NOT stored");
    ok(!roomMap().has("peek-x"), "peek id absent");
  },

  "S5 self-exclusion holds across repeated broadcasts": () => {
    reset();
    call(A); call(B);
    for (let i = 0; i < 3; i++) {
      const r = call(A);
      ok(!r.body.members.some((m) => m.id === "car-modelx"), `iter ${i}: A not in own list`);
    }
  },

  "S6 same-id rebroadcast upserts position (no duplicate)": () => {
    reset();
    call(A);
    call({ ...A, lat: 60.0, lng: 11.0 });
    eq(roomMap().size, 1, "still one entry");
    const v = memberOf("car-modelx");
    eq(v.lat, 60.0, "lat updated");
    eq(v.lng, 11.0, "lng updated");
  },

  "S7 explicit leave removes the member": () => {
    reset();
    call(A); call(B);
    const r = call({ room: ROOM, id: "car-modelx", leave: true });
    eq(r.status, 200, "leave ok");
    eq(r.body.members.length, 0, "leave returns empty list");
    ok(!roomMap().has("car-modelx"), "A removed");
    ok(roomMap().has("car-modely_lr"), "B still present");
  },

  "S7b leaving the last member deletes the room": () => {
    reset();
    call(A);
    call({ room: ROOM, id: "car-modelx", leave: true });
    ok(!togetherRooms.has(ROOM), "empty room deleted");
  },

  "S8 keepalive refreshes seen but not ts/position": () => {
    reset();
    call(A);
    const v = memberOf("car-modelx");
    const oldTs = v.ts - 10000;   // pretend the last fix was 10s ago
    v.ts = oldTs; v.seen = oldTs;
    const r = call({ room: ROOM, id: "car-modelx", keepalive: true });
    eq(r.status, 200, "keepalive ok");
    const v2 = memberOf("car-modelx");
    eq(v2.ts, oldTs, "ts unchanged (last fix preserved)");
    ok(v2.seen > oldTs, "seen refreshed");
    eq(v2.lat, A.lat, "position unchanged");
  },

  "S9 keepalive for an unknown member is a no-op (no register)": () => {
    reset();
    const r = call({ room: ROOM, id: "car-modelx", keepalive: true });
    eq(r.status, 200, "ok");
    eq(r.body.members.length, 0, "no members");
    ok(!togetherRooms.has(ROOM), "room not created by a bare keepalive");
  },

  "S10 invalid coordinates are not stored": () => {
    reset();
    call({ room: ROOM, id: "car-modelx", lat: 999, lng: 10 });        // lat out of range
    call({ room: ROOM, id: "car-modely_lr", lat: 60, lng: 999 });      // lng out of range
    call({ room: ROOM, id: "car-modely_p", lat: "x", lng: 10 });       // non-numeric
    call({ room: ROOM, id: "car-modelx", lat: NaN, lng: 10 });         // NaN
    ok(!togetherRooms.has(ROOM), "nothing registered from bad coords");
  },

  "S11 name sanitisation: strip <>/trim/cap 24, default Traveller": () => {
    reset();
    call({ room: ROOM, id: "car-modelx", lat: 59, lng: 10, name: "<script>Arijit</script>" });
    const n1 = memberOf("car-modelx").name;
    ok(!/[<>]/.test(n1), "angle brackets stripped");
    ok(n1.length <= 24, "name capped at 24");
    call({ room: ROOM, id: "car-modely_lr", lat: 60, lng: 5, name: "   " });
    eq(memberOf("car-modely_lr").name, "Traveller", "blank -> Traveller");
    call({ room: ROOM, id: "car-modely_p", lat: 63, lng: 10, name: "x".repeat(50) });
    eq(memberOf("car-modely_p").name.length, 24, "long name truncated to 24");
    eq(cleanMemberName("<b>Ann</b>").includes("<"), false, "cleanMemberName strips <");
  },

  "S12 accuracy: valid kept; out-of-range -> null": () => {
    reset();
    call({ ...A, acc: 30 });
    eq(memberOf("car-modelx").acc, 30, "valid acc kept");
    call({ ...A, acc: -5 });
    eq(memberOf("car-modelx").acc, null, "negative acc -> null");
    call({ ...A, acc: 200000 });
    eq(memberOf("car-modelx").acc, null, ">100km acc -> null");
    call({ ...A, acc: 100000 });
    eq(memberOf("car-modelx").acc, 100000, "boundary 100000 kept");
  },

  "S13 TTL prune drops members past the backstop window": () => {
    reset();
    call(A); call(B);
    // Age A past the TTL; any activity on the room should prune it.
    memberOf("car-modelx").seen = Date.now() - TOGETHER_TTL_MS - 1000;
    const r = call({ room: ROOM, id: "peek-x" });
    ok(!roomMap().has("car-modelx"), "stale A pruned");
    eq(r.body.members.length, 1, "only B remains");
    // Age all -> room empties and is deleted.
    memberOf("car-modely_lr").seen = Date.now() - TOGETHER_TTL_MS - 1000;
    call({ room: ROOM, id: "peek-x" });
    ok(!togetherRooms.has(ROOM), "emptied room deleted");
  },

  "S14 room-full evicts the stalest, never rejects": () => {
    reset();
    for (let i = 0; i < TOGETHER_MAX_MEMBERS; i++) {
      call({ room: ROOM, id: "car-x" + i, name: "C" + i, lat: 59 + i * 0.01, lng: 10 });
    }
    eq(roomMap().size, TOGETHER_MAX_MEMBERS, "room at capacity");
    // Make car-x0 the clear stalest, then add a brand-new car.
    memberOf("car-x0").seen = Date.now() - 999999;
    const r = call({ room: ROOM, id: "car-NEW", name: "New", lat: 64, lng: 11 });
    eq(r.status, 200, "join never rejected");
    eq(roomMap().size, TOGETHER_MAX_MEMBERS, "size stays capped");
    ok(!roomMap().has("car-x0"), "stalest evicted");
    ok(roomMap().has("car-NEW"), "newcomer present");
  },

  "S15 room/id sanitisation (strip illegal chars, truncate)": () => {
    reset();
    const r = call({ room: "a b!@#", id: "x*&^", lat: 59, lng: 10 });
    eq(r.status, 200, "sanitised keys still valid");
    ok(togetherRooms.has("ab"), "room sanitised to 'ab'");
    ok(togetherRooms.get("ab").has("x"), "id sanitised to 'x'");
    reset();
    call({ room: "r".repeat(60), id: "i".repeat(80), lat: 59, lng: 10 });
    const roomKey = [...togetherRooms.keys()][0];
    eq(roomKey.length, 40, "room truncated to 40");
    const idKey = [...togetherRooms.get(roomKey).keys()][0];
    eq(idKey.length, 64, "id truncated to 64");
  },
};

// ---- run the suite N times -------------------------------------------------
const ITERATIONS = 10;
console.log(`Running ${Object.keys(scenarios).length} Together-mode scenarios x ${ITERATIONS} iterations\n`);
for (let it = 1; it <= ITERATIONS; it++) {
  const before = failed;
  for (const [name, fn] of Object.entries(scenarios)) {
    try { fn(); }
    catch (e) { failed++; fails.push(`[THREW] ${name}: ${e.message}`); }
  }
  const delta = failed - before;
  console.log(`  iteration ${String(it).padStart(2)}: ${delta === 0 ? "OK" : delta + " failure(s)"}`);
}

console.log(`\nAssertions passed: ${passed}, failed: ${failed}`);
if (fails.length) {
  console.log("\nFailures (first 30):");
  [...new Set(fails)].slice(0, 30).forEach((f) => console.log("  ✗ " + f));
}
process.exit(failed ? 1 : 0);
