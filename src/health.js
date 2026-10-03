// health.js — Phase 2 "See" (Oct 2026)
//
// One place that knows whether this service is healthy:
//   - job registry: every scheduled job records success/failure + timestamps
//   - runJob(): wraps a job so one exception logs + alerts instead of
//     killing the run (or the process)
//   - alert(): Telegram to the owner, throttled per key (default 1/hour),
//     with a one-off "recovered" message when a failing key clears
//   - installProcessHandlers(): unhandledRejection / uncaughtException alert
//   - healthSnapshot(): what GET /health returns. Public view has timestamps
//     and ok/fail only; error text only for x-admin-secret callers.
//
// Commit hash comes from RAILWAY_GIT_COMMIT_SHA (set by Railway on GitHub
// deploys; empty for `railway up` CLI deploys → shows "unknown").
//
// This file is copied, near-identical, into Toolbox, Fixatum and
// TheRecordKeeper. Keep the three in step.

const SERVICE   = process.env.HEALTH_SERVICE_NAME || "hederatoolbox";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = process.env.TELEGRAM_OWNER_ID;
const ALERT_THROTTLE_MS = (Number(process.env.ALERT_THROTTLE_MIN) || 60) * 60_000;

const startedAt = new Date();
const COMMIT    = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown";

// ── Alerts ────────────────────────────────────────────────────────────────────

const lastAlertAt = new Map();   // key -> ms
const failingKeys = new Set();   // keys currently in a failed state

async function sendTelegram(text) {
  if (!BOT_TOKEN || !OWNER_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: OWNER_ID, text: text.slice(0, 3900), parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (e) {
    console.error(`[Health] Telegram send failed: ${e.message}`);
    return false;
  }
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Alert the owner. Same key alerts at most once per throttle window.
// Never throws.
export async function alert(key, message) {
  try {
    failingKeys.add(key);
    const now = Date.now();
    const last = lastAlertAt.get(key) || 0;
    console.error(`[Alert] ${key}: ${message}`);
    if (now - last < ALERT_THROTTLE_MS) return;
    lastAlertAt.set(key, now);
    await sendTelegram(`⚠️ <b>${esc(SERVICE)}</b> — ${esc(key)}\n\n${esc(message)}`);
  } catch { /* never propagate */ }
}

// Call when the condition behind an alert key is healthy again.
// Sends one "recovered" message if the key had been alerting.
export async function clear(key, message = "recovered") {
  try {
    if (!failingKeys.has(key)) return;
    failingKeys.delete(key);
    lastAlertAt.delete(key);
    console.error(`[Alert] ${key}: ${message}`);
    await sendTelegram(`✅ <b>${esc(SERVICE)}</b> — ${esc(key)}\n\n${esc(message)}`);
  } catch { /* never propagate */ }
}

// ── Job registry ──────────────────────────────────────────────────────────────

const jobs = new Map();

// expectedEveryMs: how often the job should succeed. A job whose last success
// is older than 2× this (plus 5 min grace) is "stale" and the service reports
// "degraded".
export function registerJob(name, expectedEveryMs) {
  if (!jobs.has(name)) {
    jobs.set(name, {
      expected_every_s: Math.round(expectedEveryMs / 1000),
      runs: 0, failures: 0, consecutive_failures: 0,
      last_success_at: null, last_failure_at: null, last_error: null,
    });
  }
  return jobs.get(name);
}

export function jobSucceeded(name) {
  const j = jobs.get(name) || registerJob(name, 0);
  j.runs++;
  j.last_success_at = new Date().toISOString();
  if (j.consecutive_failures > 0) {
    j.consecutive_failures = 0;
    clear(`job:${name}`, `${name} succeeded again`);
  }
}

// alertAfter: consecutive failures before alerting (pollers use 3; daily jobs 1)
export function jobFailed(name, err, { alertAfter = 1 } = {}) {
  const j = jobs.get(name) || registerJob(name, 0);
  j.runs++;
  j.failures++;
  j.consecutive_failures++;
  j.last_failure_at = new Date().toISOString();
  j.last_error = String(err?.message || err).slice(0, 300);
  if (j.consecutive_failures >= alertAfter) {
    alert(`job:${name}`, `${name} failed (${j.consecutive_failures}× in a row): ${j.last_error}`);
  }
}

// Wrap a job. Returns the job's result, or undefined on failure. Never throws.
export async function runJob(name, fn, opts = {}) {
  try {
    const out = await fn();
    jobSucceeded(name);
    return out;
  } catch (e) {
    console.error(`[Job] ${name} failed: ${e?.stack || e}`);
    jobFailed(name, e, opts);
    return undefined;
  }
}

function jobView(name, j, includeErrors) {
  const now = Date.now();
  const lastOk = j.last_success_at ? Date.parse(j.last_success_at) : null;
  const limitMs = j.expected_every_s * 2000 + 5 * 60_000;
  // Before the first run is due, a job isn't stale yet.
  const sinceStart = now - startedAt.getTime();
  const stale = j.expected_every_s > 0 &&
    (lastOk ? now - lastOk > limitMs : sinceStart > limitMs);
  const v = {
    ok: !stale && j.consecutive_failures === 0,
    stale,
    expected_every_s: j.expected_every_s,
    runs: j.runs,
    failures: j.failures,
    consecutive_failures: j.consecutive_failures,
    last_success_at: j.last_success_at,
    last_failure_at: j.last_failure_at,
  };
  if (includeErrors) v.last_error = j.last_error;
  return v;
}

// ── Snapshot for GET /health ──────────────────────────────────────────────────

export function healthSnapshot({ version, includeErrors = false, extra = {} } = {}) {
  const jobsOut = {};
  let degraded = false;
  for (const [name, j] of jobs) {
    const v = jobView(name, j, includeErrors);
    if (!v.ok) degraded = true;
    jobsOut[name] = v;
  }
  return {
    status: degraded ? "degraded" : "ok",
    service: SERVICE,
    version,
    commit: COMMIT,
    started_at: startedAt.toISOString(),
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    jobs: jobsOut,
    ...(includeErrors ? { alerting: [...failingKeys] } : {}),
    ...extra,
    timestamp: new Date().toISOString(),
  };
}

// ── Process-level safety net ──────────────────────────────────────────────────

let handlersInstalled = false;
export function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // A stray rejected promise is logged + alerted, not fatal.
  process.on("unhandledRejection", (reason) => {
    console.error("[Health] Unhandled rejection:", reason?.stack || reason);
    alert("unhandled_rejection", String(reason?.message || reason).slice(0, 300));
  });

  // An uncaught exception leaves the process in an unknown state: alert,
  // give Telegram a moment, then exit(1) so Railway restarts cleanly.
  process.on("uncaughtException", (err) => {
    console.error("[Health] Uncaught exception:", err?.stack || err);
    lastAlertAt.delete("uncaught_exception");
    alert("uncaught_exception", `${String(err?.message || err).slice(0, 300)} — restarting`)
      .finally(() => setTimeout(() => process.exit(1), 1500));
    setTimeout(() => process.exit(1), 5000).unref();
  });

  sendStartupNotice();
}

// One quiet line in the logs on every boot; Telegram only if asked for.
function sendStartupNotice() {
  console.error(`[Health] ${SERVICE} started — commit ${COMMIT}`);
  if (process.env.HEALTH_NOTIFY_ON_START === "true") {
    sendTelegram(`🔄 <b>${esc(SERVICE)}</b> started — commit <code>${esc(COMMIT)}</code>`);
  }
}
