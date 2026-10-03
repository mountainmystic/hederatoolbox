// watchdog.js — Phase 2 "See" (Oct 2026)
//
// Runs inside Toolbox. Two schedules:
//
//  Watchdog (every WATCHDOG_EVERY_MIN, default 30):
//   1. TheRecordKeeper witness log (topic 0.0.10425150) has a message newer
//      than WITNESS_MAX_AGE_H (default 26h — TRK writes once a day, 23h gate).
//   2. Watched Toolbox credit balances are above their floor.
//      WATCH_CREDIT="0.0.10394452:10" (Fixatum: ~3 registrations' worth +
//      screening refreshes). Comma-separate more "account:floorHbar" pairs.
//   3. Sibling services answer /health with status "ok".
//      WATCH_HEALTH_URLS default "https://did.fixatum.com/health".
//      Add TheRecordKeeper's URL here once it has a /health route deployed.
//
//  Daily canary (CANARY_HOUR_UTC, default 09 — after the 08:00 TRK heartbeat
//  and digest):
//   a. Toolbox MCP tools/list over the public URL — includes account_info
//   b. account_info (free) — returns a platform wallet
//   c. Fixatum score query (unregistered account, free) — score 0–100 + grade
//   d. Fixatum /health registration_ready === true  (registration dry-run:
//      key/config present, payment watcher polling, price loaded — no HBAR)
//   e. ONE real paid call (hcs_monitor on the witness topic, 0.1 HBAR) — only
//      when CANARY_API_KEY is set. Uses CANARY_API_SECRET if that account is
//      protected. Account must already have accepted terms (confirm_terms).
//  Any failed check → one Telegram alert listing what failed.
//
// Every run goes through health.runJob, so a crash here alerts instead of
// killing anything. Every check is read-only except (e), which costs 0.1 HBAR.

import { runJob, registerJob, alert, clear } from "./health.js";
import { getBalance } from "./db.js";

const PUBLIC_BASE   = (process.env.CANARY_TOOLBOX_URL || "https://api.hederatoolbox.com").replace(/\/$/, "");
const FIXATUM_BASE  = (process.env.FIXATUM_API_URL || "https://did.fixatum.com").replace(/\/$/, "");
const MIRROR        = "https://mainnet-public.mirrornode.hedera.com";
const WITNESS_TOPIC = process.env.WITNESS_TOPIC_ID || "0.0.10425150";
const WITNESS_MAX_AGE_H = Number(process.env.WITNESS_MAX_AGE_H) || 26;
const EVERY_MS      = (Number(process.env.WATCHDOG_EVERY_MIN) || 30) * 60_000;
const CANARY_HOUR   = Number.isFinite(Number(process.env.CANARY_HOUR_UTC)) && process.env.CANARY_HOUR_UTC !== ""
  ? Number(process.env.CANARY_HOUR_UTC) : 9;
// Unregistered on purpose: since 10-02 an unregistered score query never
// triggers a paid screening refresh, so the daily canary costs Fixatum nothing.
// (A registered account here would force a 1 HBAR re-screen every day.)
const CANARY_SCORE_ACCOUNT = process.env.CANARY_SCORE_ACCOUNT || "0.0.800";

function parseCreditWatch(raw) {
  const out = [];
  for (const entry of (raw ?? "0.0.10394452:10").split(",")) {
    const [acct, floor] = entry.split(":").map(s => (s || "").trim());
    if (/^\d+\.\d+\.\d+$/.test(acct) && Number(floor) > 0) out.push({ acct, floor: Number(floor) });
  }
  return out;
}
const CREDIT_WATCH = parseCreditWatch(process.env.WATCH_CREDIT);
const HEALTH_URLS  = (process.env.WATCH_HEALTH_URLS ?? `${FIXATUM_BASE}/health`)
  .split(",").map(s => s.trim()).filter(Boolean);

// ── HTTP helpers (fetch, Node 22) ─────────────────────────────────────────────

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, data };
}

// JSON-RPC to the public MCP endpoint. Handles plain JSON or SSE replies.
// Returns { rpc, tool } — tool is the parsed text payload of a tools/call.
async function mcp(method, params) {
  const res = await fetch(`${PUBLIC_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const candidates = text.includes("data:")
    ? text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim())
    : [text];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const rpc = JSON.parse(candidates[i]);
      let tool = null;
      const t = rpc?.result?.content?.[0]?.text;
      if (t) { try { tool = JSON.parse(t); } catch { tool = { raw: t }; } }
      return { rpc, tool, isError: !!rpc?.result?.isError };
    } catch { /* try previous line */ }
  }
  throw new Error(`MCP ${method}: unparseable response (HTTP ${res.status})`);
}

// ── Watchdog checks ───────────────────────────────────────────────────────────

async function checkWitness() {
  const { status, data } = await getJson(`${MIRROR}/api/v1/topics/${WITNESS_TOPIC}/messages?order=desc&limit=1`);
  if (status !== 200) throw new Error(`mirror node HTTP ${status}`);
  const msg = data?.messages?.[0];
  if (!msg) throw new Error("no messages on witness topic");
  const ageH = (Date.now() / 1000 - parseFloat(msg.consensus_timestamp)) / 3600;
  const key = "witness_stale";
  if (ageH > WITNESS_MAX_AGE_H) {
    await alert(key, `TheRecordKeeper witness log quiet for ${ageH.toFixed(1)}h (seq ${msg.sequence_number}, limit ${WITNESS_MAX_AGE_H}h).`);
  } else {
    await clear(key, `Witness log advancing again — seq ${msg.sequence_number}, ${ageH.toFixed(1)}h old.`);
  }
  return { seq: msg.sequence_number, age_h: Number(ageH.toFixed(2)) };
}

async function checkCredits() {
  const out = {};
  for (const { acct, floor } of CREDIT_WATCH) {
    const hbar = getBalance(acct) / 1e8;
    out[acct] = hbar;
    const key = `low_credit:${acct}`;
    if (hbar < floor) {
      await alert(key, `Toolbox credit for ${acct} is ${hbar.toFixed(4)} HBAR (floor ${floor}). Top up before it starts failing calls.`);
    } else {
      await clear(key, `Toolbox credit for ${acct} back above floor: ${hbar.toFixed(4)} HBAR.`);
    }
  }
  return out;
}

async function checkSiblings() {
  const out = {};
  for (const url of HEALTH_URLS) {
    const key = `sibling:${new URL(url).host}`;
    let problem = null;
    try {
      const { status, data } = await getJson(url);
      if (status !== 200) problem = `HTTP ${status}`;
      else if (data?.status !== "ok") problem = `status "${data?.status}"` +
        (data?.jobs ? ` — not ok: ${Object.entries(data.jobs).filter(([, j]) => !j.ok).map(([n]) => n).join(", ") || "none listed"}` : "");
      out[url] = problem || "ok";
    } catch (e) {
      problem = e.message;
      out[url] = `error: ${e.message}`;
    }
    if (problem) await alert(key, `${url} unhealthy: ${problem}`);
    else await clear(key, `${url} healthy again.`);
  }
  return out;
}

async function watchdogRun() {
  // Each check isolated: one failing (e.g. mirror node blip) doesn't hide the others.
  const results = {};
  const errors = [];
  for (const [name, fn] of [["witness", checkWitness], ["credits", checkCredits], ["siblings", checkSiblings]]) {
    try { results[name] = await fn(); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  lastWatchdog = { at: new Date().toISOString(), results, errors };
  // Throwing marks the job failed; alerts after 3 consecutive (mirror blips are common).
  if (errors.length) throw new Error(errors.join("; "));
}

// ── Daily canary ──────────────────────────────────────────────────────────────

async function canaryRun() {
  const checks = [];
  const pass = (name, detail = "ok") => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => checks.push({ name, ok: false, detail: String(detail).slice(0, 200) });
  const step = async (name, fn) => { try { const d = await fn(); pass(name, d); } catch (e) { fail(name, e.message); } };

  await step("tools_list", async () => {
    const { rpc } = await mcp("tools/list", {});
    const names = (rpc?.result?.tools || []).map(t => t.name);
    if (!names.includes("account_info")) throw new Error(`account_info missing (${names.length} tools listed)`);
    return `${names.length} tools`;
  });

  await step("account_info_free", async () => {
    const { tool, isError } = await mcp("tools/call", { name: "account_info", arguments: {} });
    if (isError || tool?.error) throw new Error(tool?.error || "isError");
    const s = JSON.stringify(tool || {});
    if (!/0\.0\.\d+/.test(s)) throw new Error("no account ID in response");
    return "ok";
  });

  await step("fixatum_score", async () => {
    const { status, data } = await getJson(`${FIXATUM_BASE}/score/${CANARY_SCORE_ACCOUNT}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const score = data?.score;
    if (typeof score !== "number" || score < 0 || score > 100) throw new Error(`bad score field: ${JSON.stringify(score)}`);
    if (!data?.grade) throw new Error("missing grade");
    return `${score} ${data.grade}`;
  });

  await step("registration_dry_run", async () => {
    const { status, data } = await getJson(`${FIXATUM_BASE}/health`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (data?.registration_ready !== true) {
      throw new Error(`registration_ready=${JSON.stringify(data?.registration_ready)} ${JSON.stringify(data?.registration_checks || {})}`);
    }
    return "ready";
  });

  const canaryKey = process.env.CANARY_API_KEY;
  if (canaryKey) {
    await step("paid_call", async () => {
      const args = { api_key: canaryKey, topic_id: WITNESS_TOPIC };
      if (process.env.CANARY_API_SECRET) args.api_secret = process.env.CANARY_API_SECRET;
      const { tool, isError } = await mcp("tools/call", { name: "hcs_monitor", arguments: args });
      if (isError || tool?.error) throw new Error(tool?.error || "isError");
      return "hcs_monitor ok";
    });
  } else {
    checks.push({ name: "paid_call", ok: null, detail: "skipped — CANARY_API_KEY not set" });
  }

  lastCanary = { at: new Date().toISOString(), checks };
  const failed = checks.filter(c => c.ok === false);
  if (failed.length) {
    // Thrown → runJob records it and sends ONE Telegram alert (and a
    // "succeeded again" message on the first passing run after).
    throw new Error(`${failed.length} check(s) failed — ` +
      failed.map(c => `${c.name}: ${c.detail}`).join(" | "));
  }
  console.error(`[Canary] all checks passed: ${checks.map(c => `${c.name}=${c.ok === null ? "skip" : "ok"}`).join(" ")}`);
}

// ── State for /health (admin view) ────────────────────────────────────────────

let lastWatchdog = null;
let lastCanary   = null;
export function watchdogState() { return { watchdog: lastWatchdog, canary: lastCanary }; }

// ── Start ─────────────────────────────────────────────────────────────────────

export function startWatchdog() {
  if (process.env.WATCHDOG_ENABLED === "false") {
    console.error("[Watchdog] disabled (WATCHDOG_ENABLED=false)");
    return;
  }
  registerJob("watchdog", EVERY_MS);
  registerJob("canary", 24 * 3600_000);

  // First watchdog pass 2 min after boot (let the server settle), then every EVERY_MS.
  setTimeout(() => {
    runJob("watchdog", watchdogRun, { alertAfter: 3 });
    setInterval(() => runJob("watchdog", watchdogRun, { alertAfter: 3 }), EVERY_MS);
  }, 120_000);

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(CANARY_HOUR, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    runJob("canary", canaryRun);
    setInterval(() => runJob("canary", canaryRun), 24 * 3600_000);
  }, next - now);

  console.error(`[Watchdog] every ${EVERY_MS / 60000} min; canary daily ${String(CANARY_HOUR).padStart(2, "0")}:00 UTC` +
    ` (paid call ${process.env.CANARY_API_KEY ? "ON" : "off"}); credit watch: ${CREDIT_WATCH.map(c => `${c.acct}<${c.floor}`).join(", ") || "none"}`);
}

// Manual trigger for the admin route — runs the canary now.
export function runCanaryNow() { return runJob("canary", canaryRun); }
