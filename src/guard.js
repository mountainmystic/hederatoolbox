// guard.js — Phase 1 containment (Oct 2026)
//
// Three jobs:
//   1. Protected accounts: an account listed in PROTECTED_ACCOUNTS can only be
//      used as api_key when the call also carries the matching api_secret.
//      A public account ID alone is no longer enough to spend its credit or
//      act under its identity.
//   2. Spend circuit breaker: watches paid-call velocity and tool diversity per
//      api_key over the last hour. BREAKER_MODE=alert (default) only notifies;
//      BREAKER_MODE=enforce also freezes the key for BREAKER_FREEZE_HOURS.
//   3. DID attribution check: a caller-supplied agent_did only counts for
//      provenance when its account suffix matches the api_key.
//
// Env:
//   PROTECTED_ACCOUNTS     "0.0.111:<sha256hex>,0.0.222:<sha256hex>" (hashes, never secrets)
//   BREAKER_MODE           off | alert | enforce   (default alert)
//   BREAKER_MAX_CALLS      paid calls per key per hour  (default 60)
//   BREAKER_MAX_TOOLS      distinct paid tools per key per hour (default 8)
//   BREAKER_FREEZE_HOURS   freeze length in enforce mode (default 24)
//
// Generate a secret + hash with: node scripts/make-account-secret.mjs

import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";
import { notifyOwner } from "./telegram.js";

// ── 1. Protected accounts ─────────────────────────────────────────────────────

function parseProtected(raw) {
  const map = new Map();
  for (const entry of (raw || "").split(",")) {
    const [acct, hash] = entry.split(":").map(s => (s || "").trim());
    if (/^\d+\.\d+\.\d+$/.test(acct) && /^[0-9a-f]{64}$/i.test(hash)) {
      map.set(acct, Buffer.from(hash.toLowerCase(), "hex"));
    }
  }
  return map;
}

const PROTECTED = parseProtected(process.env.PROTECTED_ACCOUNTS);
console.error(`[Guard] ${PROTECTED.size} protected account(s) loaded; breaker mode: ${breakerMode()}`);

export function isProtectedAccount(apiKey) {
  return PROTECTED.has(apiKey);
}

function secretMatches(apiKey, secret) {
  const expected = PROTECTED.get(apiKey);
  if (!expected || typeof secret !== "string" || !secret) return false;
  const got = createHash("sha256").update(secret, "utf8").digest();
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Returns { verified } — verified=true means the caller proved it holds the
// secret for a protected account. Throws for a protected account without a
// valid secret. Unprotected accounts pass through with verified=false.
export function checkProtectedAccount(apiKey, apiSecret, toolName) {
  if (!apiKey || !PROTECTED.has(apiKey)) return { verified: false };
  if (secretMatches(apiKey, apiSecret)) return { verified: true };
  alertOnce(`denied:${apiKey}`, `🛑 Guard: refused ${toolName} for protected account ${apiKey} (missing or wrong api_secret)`);
  throw new Error(
    `This account requires an api_secret on every call. ` +
    `If this is your account and you have lost the secret, contact the platform operator.`
  );
}

// Remove credentials before args reach any tool module or log.
export function stripSecret(args) {
  if (!args || typeof args !== "object") return args;
  const { api_secret, ...rest } = args;
  return rest;
}

// ── 2. Spend circuit breaker ──────────────────────────────────────────────────

function breakerMode() {
  const m = (process.env.BREAKER_MODE || "alert").toLowerCase();
  return ["off", "alert", "enforce"].includes(m) ? m : "alert";
}
const MAX_CALLS    = Number(process.env.BREAKER_MAX_CALLS)    || 60;
const MAX_TOOLS    = Number(process.env.BREAKER_MAX_TOOLS)    || 8;
const FREEZE_HOURS = Number(process.env.BREAKER_FREEZE_HOURS) || 24;

db.exec(`
  CREATE TABLE IF NOT EXISTS spend_freezes (
    api_key    TEXT PRIMARY KEY,
    frozen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    until      TEXT NOT NULL,
    reason     TEXT
  );
`);

const guardStmts = {
  hourStats: db.prepare(`
    SELECT COUNT(*) AS calls, COUNT(DISTINCT tool_name) AS tools
    FROM   transactions
    WHERE  api_key = ? AND timestamp >= datetime('now', '-1 hour')
  `),
  getFreeze: db.prepare(`SELECT * FROM spend_freezes WHERE api_key = ? AND until > datetime('now')`),
  freeze:    db.prepare(`
    INSERT INTO spend_freezes (api_key, until, reason)
    VALUES (?, datetime('now', ?), ?)
    ON CONFLICT(api_key) DO UPDATE SET frozen_at = datetime('now'), until = excluded.until, reason = excluded.reason
  `),
  unfreeze:  db.prepare(`DELETE FROM spend_freezes WHERE api_key = ?`),
  listFrozen: db.prepare(`SELECT * FROM spend_freezes WHERE until > datetime('now') ORDER BY frozen_at DESC`),
};

// One Telegram message per key per kind per hour — never spam, never throw.
const lastAlert = new Map();
function alertOnce(key, text) {
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < 3_600_000) return;
  lastAlert.set(key, now);
  Promise.resolve().then(() => notifyOwner(text)).catch(() => {});
}

// Call before charging for a paid tool. Counts include past calls only, so
// the check is "would this call push the key over the line".
export function checkSpendBreaker(apiKey, toolName, { verified = false } = {}) {
  const mode = breakerMode();
  if (mode === "off" || !apiKey) return;

  const frozen = guardStmts.getFreeze.get(apiKey);
  if (frozen && mode === "enforce") {
    throw new Error(
      `Spending on this key is paused until ${frozen.until} UTC after unusual activity. ` +
      `Contact the platform operator if this is a mistake.`
    );
  }

  if (verified) return; // proven owner of a protected account — exempt from velocity limits

  const { calls, tools } = guardStmts.hourStats.get(apiKey);
  const overCalls = calls + 1 > MAX_CALLS;
  const overTools = tools + 1 > MAX_TOOLS;
  if (!overCalls && !overTools) return;

  const reason = `${calls + 1} paid calls / ${tools + 1} distinct tools in 1h (limits ${MAX_CALLS} / ${MAX_TOOLS}); last tool ${toolName}`;

  if (mode === "enforce") {
    guardStmts.freeze.run(apiKey, `+${FREEZE_HOURS} hours`, reason);
    alertOnce(`breaker:${apiKey}`, `🧊 Breaker FROZE ${apiKey} for ${FREEZE_HOURS}h — ${reason}`);
    throw new Error(
      `Spending on this key is paused for ${FREEZE_HOURS}h after unusual activity. ` +
      `Contact the platform operator if this is a mistake.`
    );
  }
  alertOnce(`breaker:${apiKey}`, `⚠️ Breaker (alert-only) tripped for ${apiKey} — ${reason}`);
}

export function unfreezeKey(apiKey) {
  return guardStmts.unfreeze.run(apiKey).changes > 0;
}

export function listFrozenKeys() {
  return guardStmts.listFrozen.all();
}

// ── 3. DID attribution ────────────────────────────────────────────────────────

// A DID ends in _<hedera account id>. It only counts toward provenance for an
// api_key when that suffix is the api_key itself — otherwise anyone could log
// their activity under (or against) someone else's DID.
export function didBelongsToKey(agentDid, apiKey) {
  if (typeof agentDid !== "string" || !apiKey) return false;
  return agentDid.startsWith("did:hedera:") && agentDid.endsWith(`_${apiKey}`);
}
