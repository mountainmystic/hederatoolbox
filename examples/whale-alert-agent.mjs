/**
 * whale-alert-agent.mjs — HederaToolbox autonomous whale monitoring agent
 *
 * Monitors a Hedera token for unusual whale concentration on a schedule.
 * When an anomaly is detected, writes a tamper-proof alert to the Hedera
 * blockchain via HCS and prints the on-chain proof link.
 *
 * Runs forever. Alerts only fire when concentration exceeds your threshold,
 * with a cooldown to avoid duplicate on-chain writes.
 *
 * Setup (one time):
 *   1. Send any amount of HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key automatically.
 *   2. Replace YOUR_HEDERA_ACCOUNT_ID below with your account ID.
 *   3. node examples/whale-alert-agent.mjs
 *
 * Cost: 0.2 ℏ per check · 5 ℏ only when anomaly fires · 10 ℏ covers ~2 days
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY           = process.env.HEDERA_ACCOUNT_ID || "YOUR_HEDERA_ACCOUNT_ID";
const TOKEN_ID          = process.env.TOKEN_ID          || "0.0.731861";  // SAUCE by default
const THRESHOLD_PCT     = parseFloat(process.env.THRESHOLD_PCT     || "90");    // alert if top-10 holders > this %
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS   || "3600000"); // 1 hour
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS   || "21600000"); // 6h between HCS writes
const ENDPOINT          = "https://api.hederatoolbox.com/mcp";
const HASHSCAN_BASE     = "https://hashscan.io/mainnet/transaction";
// ─────────────────────────────────────────────────────────────────────────────

if (API_KEY === "YOUR_HEDERA_ACCOUNT_ID") {
  console.error("\n❌ Replace API_KEY with your Hedera account ID (e.g. \"0.0.123456\").");
  console.error("   Send any HBAR to 0.0.10309126 first — your account ID becomes your key.\n");
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let lastAlertAt = 0; // timestamp of last HCS write — prevents duplicate alerts

// ─── MCP tool caller ─────────────────────────────────────────────────────────
async function callTool(toolName, args) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: { ...args, api_key: API_KEY } },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${toolName}`);
  const json = await res.json();
  if (json.error) throw new Error(`${toolName}: ${json.error.message}`);
  const text = json.result?.content?.find(c => c.type === "text")?.text;
  if (!text) throw new Error(`No response from ${toolName}`);
  return JSON.parse(text);
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ─── Onboard (free) ──────────────────────────────────────────────────────────
async function onboard() {
  log("Checking terms and balance...");
  await callTool("get_terms", {});
  await callTool("confirm_terms", { consent: true });
  const info = await callTool("account_info", {});
  log(`Account: ${API_KEY} | Balance: ${info.balance_hbar} ℏ`);
  if (parseFloat(info.balance_hbar) < 0.5) {
    console.error(`\n❌ Insufficient balance: ${info.balance_hbar} ℏ`);
    console.error(`   Top up: send HBAR to ${info.platform_wallet}\n`);
    process.exit(1);
  }
}

// ─── Main cycle ───────────────────────────────────────────────────────────────
async function runCycle(cycleNum) {
  log(`─── Cycle #${cycleNum} — monitoring ${TOKEN_ID} ───`);

  const monitor = await callTool("token_monitor", { token_id: TOKEN_ID });

  const symbol    = monitor.symbol || TOKEN_ID;
  const holders   = monitor.total_holders;
  const conc      = parseFloat(monitor.top_10_concentration);
  const signals   = monitor.activity_signals || [];
  const priceUsd  = monitor.current_price_usd ? `$${monitor.current_price_usd}` : "not listed";
  const remaining = monitor.payment?.remaining_hbar ?? "?";

  log(`${symbol} | holders: ${holders} | top-10: ${conc}% | price: ${priceUsd} | balance: ${remaining} ℏ`);
  log(`Signals: ${signals.join(" | ")}`);

  const anomalySignals = signals.filter(s => !s.includes("No unusual"));
  const isAnomaly = conc > THRESHOLD_PCT || anomalySignals.length > 0;

  if (!isAnomaly) {
    log(`✅ No anomaly. Next check in ${CHECK_INTERVAL_MS / 60000} min.\n`);
    return;
  }

  // Cooldown check — don't write to HCS more than once per cooldown window
  const cooldownRemaining = ALERT_COOLDOWN_MS - (Date.now() - lastAlertAt);
  if (cooldownRemaining > 0) {
    log(`⚠️  Anomaly detected but cooldown active — ${Math.round(cooldownRemaining / 60000)} min remaining. Skipping HCS write.`);
    log(`   Concentration: ${conc}% | Threshold: ${THRESHOLD_PCT}%\n`);
    return;
  }

  // Write on-chain alert
  log(`🚨 Anomaly confirmed. Writing HCS alert (5 ℏ)...`);
  const alert = await callTool("hcs_write_record", {
    record_type: "whale_alert",
    entity_id: TOKEN_ID,
    data: {
      token_id: TOKEN_ID,
      symbol,
      top_10_concentration_pct: conc,
      threshold_pct: THRESHOLD_PCT,
      total_holders: holders,
      signals,
      agent: "whale-alert-agent",
    },
  });

  lastAlertAt = Date.now();

  console.log("\n" + "=".repeat(62));
  console.log(` 🚨 WHALE ALERT — ${symbol} (${TOKEN_ID})`);
  console.log(` Top-10 concentration: ${conc}%  (threshold: ${THRESHOLD_PCT}%)`);
  if (anomalySignals.length > 0) {
    anomalySignals.forEach(s => console.log(`   ⚠  ${s}`));
  }
  console.log(` HCS Record ID:  ${alert.record_id}`);
  console.log(` Transaction ID: ${alert.transaction_id}`);
  console.log(` On-chain proof: ${HASHSCAN_BASE}/${alert.transaction_id}`);
  console.log(` Balance after:  ${alert.payment?.remaining_hbar} ℏ`);
  console.log(` Next alert in:  ${ALERT_COOLDOWN_MS / 3600000}h (cooldown)`);
  console.log("=".repeat(62) + "\n");
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox — Autonomous Whale Alert Agent");
  console.log(`  Token:     ${TOKEN_ID}`);
  console.log(`  Threshold: top-10 holders > ${THRESHOLD_PCT}% triggers alert`);
  console.log(`  Interval:  every ${CHECK_INTERVAL_MS / 60000} minutes`);
  console.log(`  Cooldown:  ${ALERT_COOLDOWN_MS / 3600000}h between HCS writes`);
  console.log(`  API key:   ${API_KEY}`);
  console.log("=".repeat(62) + "\n");

  await onboard();
  log("Ready. Starting monitor loop...\n");

  let cycleNum = 1;
  while (true) {
    try {
      await runCycle(cycleNum++);
    } catch (err) {
      log(`⚠️  Cycle error: ${err.message} — retrying next interval`);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
