// Web Push — critical trip alerts (weather, "hurry up", store/fuel closing, viewer joined).
//
// Keyless by design (VAPID, no third-party account) and no database: subscriptions
// are persisted as JSONL on the App Service /home share (same pattern as analytics),
// deduped by push endpoint. If VAPID keys aren't configured the module stays inert
// (pushEnabled=false) so the rest of the app is unaffected — and so the unit tests,
// which run without VAPID env, never touch the network.

import webpush from "web-push";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const PUB = process.env.VAPID_PUBLIC_KEY || "";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:nordkapp@example.com";

export const pushEnabled = !!(PUB && PRIV);
export const publicKey = PUB;
if (pushEnabled) {
  try { webpush.setVapidDetails(SUBJECT, PUB, PRIV); }
  catch (e) { console.error("[push] VAPID setup failed:", e?.message || e); }
}

// Where subscriptions live. On App Service, HOME points at the persistent /home
// share; PUSH_SUBS_FILE overrides it; PUSH_NOFILE=1 (tests) keeps it in-memory only.
const FILE = process.env.PUSH_SUBS_FILE ||
  (process.env.HOME ? path.join(process.env.HOME, "data", "pushsubs.jsonl") : null);
const NOFILE = process.env.PUSH_NOFILE === "1" || !FILE;

const subs = new Map(); // endpoint -> { sub, name, role, room, ts }
let loaded = false;

function persistAll() {
  if (NOFILE) return;
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const lines = [...subs.values()].map((v) => JSON.stringify(v)).join("\n");
    writeFileSync(FILE, lines ? lines + "\n" : "");
  } catch (e) { console.error("[push] persist failed:", e?.message || e); }
}

export function ensurePushLoaded() {
  if (loaded) return;
  loaded = true;
  if (!NOFILE) {
    try {
      if (existsSync(FILE)) {
        for (const line of readFileSync(FILE, "utf8").split("\n")) {
          const s = line.trim(); if (!s) continue;
          try { const v = JSON.parse(s); if (v?.sub?.endpoint) subs.set(v.sub.endpoint, v); } catch { /* skip bad line */ }
        }
      }
    } catch (e) { console.error("[push] load failed:", e?.message || e); }
  }
  console.log(`[push] enabled=${pushEnabled} subs=${subs.size} file=${NOFILE ? "(memory)" : FILE}`);
}

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

// Register (or refresh) a browser's push subscription with its trip identity.
export function saveSubscription({ sub, name, role, room }) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return { ok: false, error: "invalid subscription" };
  ensurePushLoaded();
  subs.set(sub.endpoint, {
    sub,
    name: clip(name, 24),
    role: role === "viewer" ? "viewer" : "car",
    room: clip(room, 40),
    ts: Date.now(),
  });
  persistAll();
  return { ok: true, count: subs.size };
}

export function removeSubscription(endpoint) {
  ensurePushLoaded();
  if (subs.delete(endpoint)) persistAll();
  return { ok: true };
}

// Deliver a payload to a list of subscriptions, pruning dead ones (404/410 Gone).
async function sendTo(list, payload) {
  if (!pushEnabled || !list.length) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0;
  await Promise.all(list.map(async (v) => {
    try { await webpush.sendNotification(v.sub, body); sent++; }
    catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) { subs.delete(v.sub.endpoint); pruned++; }
      else console.error("[push] send failed:", code || e?.message || e);
    }
  }));
  if (pruned) persistAll();
  return { sent, pruned };
}

// Notify subscribers in a room. Options:
//   name           -> only that person's own devices (case-insensitive)
//   role           -> only "car" or "viewer" subscribers
//   exceptEndpoint -> skip a specific device (e.g. the actor themselves)
export function notifyRoom(room, payload, opts = {}) {
  if (!pushEnabled) return Promise.resolve({ sent: 0, pruned: 0 });
  ensurePushLoaded();
  const list = [...subs.values()].filter((v) =>
    v.room === room &&
    (!opts.name || v.name.toLowerCase() === String(opts.name).toLowerCase()) &&
    (!opts.role || v.role === opts.role) &&
    (!opts.exceptEndpoint || v.sub.endpoint !== opts.exceptEndpoint));
  return sendTo(list, payload);
}

export function notifyEndpoint(endpoint, payload) {
  if (!pushEnabled) return Promise.resolve({ sent: 0, pruned: 0 });
  ensurePushLoaded();
  const v = subs.get(endpoint);
  return v ? sendTo([v], payload) : Promise.resolve({ sent: 0, pruned: 0 });
}

// Read helpers (used by the pace evaluator to know who to nudge).
export function roomHasSubs(room) { ensurePushLoaded(); for (const v of subs.values()) if (v.room === room) return true; return false; }
export function _subs() { return subs; }
