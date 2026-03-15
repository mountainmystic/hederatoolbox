/**
 * token-due-diligence-agent.mjs — HederaToolbox token due diligence agent
 *
 * Full investment and listing due diligence on any Hedera token in one run.
 * Pulls price data, deep holder analysis, admin key risks, and treasury identity —
 * outputs a structured risk report with an overall verdict.
 *
 * Use cases: investors evaluating a new token, exchanges doing listing due diligence,
 * funds screening portfolio candidates, anyone doing token research.
 *
 * Setup (one time):
 *   1. Send any amount of HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key automatically.
 *   2. Replace YOUR_HEDERA_ACCOUNT_ID below with your account ID.
 *   3. node examples/token-due-diligence-agent.mjs
 *      Or: TOKEN_ID=0.0.123456 node examples/token-due-diligence-agent.mjs
 *
 * Flags:
 *   --save    Write the full report to ./dd-report-<token_id>.json
 *
 * Cost per report: ~1.0 ℏ (token_price 0.1 + token_analyze 0.6 + identity_resolve 0.2 on treasury)
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY   = process.env.HEDERA_ACCOUNT_ID || "YOUR_HEDERA_ACCOUNT_ID";
const TOKEN_ID  = process.env.TOKEN_ID          || "0.0.731861";  // SAUCE by default
const SAVE      = process.argv.includes("--save");
const ENDPOINT  = "https://api.hederatoolbox.com/mcp";
// ─────────────────────────────────────────────────────────────────────────────

if (API_KEY === "YOUR_HEDERA_ACCOUNT_ID") {
  console.error("\n❌ Replace API_KEY with your Hedera account ID (e.g. \"0.0.123456\").");
  console.error("   Send any HBAR to 0.0.10309126 first — your account ID becomes your key.\n");
  process.exit(1);
}

// ─── MCP tool caller ──────────────────────────────────────────────────────────
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
function sep(char = "─", len = 62) { console.log(char.repeat(len)); }

function riskBadge(level) {
  return level === "HIGH" ? "🔴 HIGH" : level === "MEDIUM" ? "🟡 MEDIUM" : "🟢 LOW";
}

// ─── Onboard ──────────────────────────────────────────────────────────────────
async function onboard() {
  await callTool("get_terms", {});
  await callTool("confirm_terms", { consent: true });
  const info = await callTool("account_info", {});
  log(`Account: ${API_KEY} | Balance: ${info.balance_hbar} ℏ`);
  if (parseFloat(info.balance_hbar) < 1) {
    console.error(`\n❌ Insufficient balance: ${info.balance_hbar} ℏ (need ~1 ℏ)`);
    console.error(`   Top up: send HBAR to ${info.platform_wallet}\n`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox — Token Due Diligence Agent");
  console.log(`  Token: ${TOKEN_ID}`);
  if (SAVE) console.log(`  Output: dd-report-${TOKEN_ID.replace(/\./g, "-")}.json`);
  console.log("=".repeat(62) + "\n");

  await onboard();
  log("Starting due diligence...\n");

  // ── Step 1: Price & market data ───────────────────────────────────────────
  log("Step 1/3 — Price & market data (0.1 ℏ)...");
  const price = await callTool("token_price", { token_id: TOKEN_ID });

  sep();
  console.log(` ${price.name} (${price.symbol}) — ${TOKEN_ID}`);
  sep();
  console.log(` Price (USD):    ${price.price_usd ? "$" + price.price_usd : "not listed on DEX"}`);
  console.log(` Price (HBAR):   ${price.price_hbar ?? "—"}`);
  console.log(` 1h change:      ${price.price_change_1h_pct ?? "—"}`);
  console.log(` 24h change:     ${price.price_change_24h_pct ?? "—"}`);
  console.log(` 7d change:      ${price.price_change_7d_pct ?? "—"}`);
  console.log(` Liquidity:      ${price.liquidity_usd ?? "—"}`);
  console.log(` Total supply:   ${price.total_supply}`);
  console.log(` Holders:        ${price.holder_count}`);
  console.log(` DEX listed:     ${price.price_source}`);
  if (price.due_diligence_complete !== null) {
    console.log(` DEX DD:         ${price.due_diligence_complete ? "✅ Complete" : "⚠️  Incomplete"}`);
  }

  // ── Step 2: Deep token analysis ───────────────────────────────────────────
  log("\nStep 2/3 — Deep token analysis (0.6 ℏ)...");
  const analysis = await callTool("token_analyze", { token_id: TOKEN_ID });

  sep();
  console.log(" RISK ASSESSMENT");
  sep();
  console.log(` Risk level:     ${riskBadge(analysis.risk_assessment.level)} (score: ${analysis.risk_assessment.score}/100)`);
  console.log(` Factors:`);
  analysis.risk_assessment.factors.forEach(f => console.log(`   • ${f}`));

  sep();
  console.log(" HOLDER CONCENTRATION");
  sep();
  console.log(` Top 1 holder:   ${analysis.concentration.top_1_pct} of supply`);
  console.log(` Top 5 holders:  ${analysis.concentration.top_5_pct} of supply`);
  console.log(` Top 10 holders: ${analysis.concentration.top_10_pct} of supply`);
  console.log(` Total holders:  ${analysis.total_holders}`);

  sep();
  console.log(" TOP 5 HOLDERS");
  sep();
  analysis.top_holders.slice(0, 5).forEach(h => {
    const label = h.account === analysis.treasury ? " (treasury)" : "";
    console.log(` #${h.rank} ${h.account}${label}`);
    console.log(`    ${h.balance} ${analysis.symbol} — ${h.pct_supply}`);
  });

  sep();
  console.log(" ADMIN KEYS (centralisation risk)");
  sep();
  const keys = analysis.admin_keys;
  console.log(` Freeze key:  ${keys.freeze_key ? "⚠️  Present — admin can freeze accounts" : "✅ None"}`);
  console.log(` Wipe key:    ${keys.wipe_key   ? "⚠️  Present — admin can wipe balances"   : "✅ None"}`);
  console.log(` Supply key:  ${keys.supply_key ? "ℹ️  Present — admin can mint/burn"        : "✅ None"}`);
  console.log(` KYC key:     ${keys.kyc_key    ? "ℹ️  Present — KYC required for transfers" : "✅ None"}`);
  console.log(` Pause key:   ${keys.pause_key  ? "⚠️  Present — admin can pause token"      : "✅ None"}`);

  // ── Step 3: Treasury account screening ───────────────────────────────────
  log("\nStep 3/3 — Screening treasury account (0.2 ℏ)...");
  const treasury = await callTool("identity_resolve", { account_id: analysis.treasury });

  sep();
  console.log(" TREASURY ACCOUNT");
  sep();
  console.log(` Account:     ${analysis.treasury}`);
  console.log(` Age:         ${treasury.account_age_days ?? "unknown"} days`);
  console.log(` Balance:     ${treasury.hbar_balance}`);
  console.log(` Summary:     ${treasury.identity_summary}`);

  // ── Final verdict ─────────────────────────────────────────────────────────
  const level = analysis.risk_assessment.level;
  const verdict =
    level === "HIGH"   ? "⛔ HIGH RISK — significant concerns identified"
    : level === "MEDIUM" ? "⚠️  MEDIUM RISK — review flagged items before proceeding"
    :                      "✅ LOW RISK — no major concerns detected";

  const report = {
    generated_at: new Date().toISOString(),
    token_id: TOKEN_ID,
    name: analysis.name,
    symbol: analysis.symbol,
    verdict,
    risk_level: level,
    risk_score: analysis.risk_assessment.score,
    risk_factors: analysis.risk_assessment.factors,
    price_usd: price.price_usd,
    liquidity_usd: price.liquidity_usd,
    price_change_24h: price.price_change_24h_pct,
    total_holders: analysis.total_holders,
    concentration: analysis.concentration,
    admin_keys: keys,
    treasury: {
      account: analysis.treasury,
      age_days: treasury.account_age_days,
      summary: treasury.identity_summary,
    },
    dex_due_diligence_complete: price.due_diligence_complete,
  };

  console.log("\n" + "=".repeat(62));
  console.log(`  DUE DILIGENCE — ${analysis.name} (${analysis.symbol})`);
  console.log("=".repeat(62));
  console.log(` Verdict:     ${verdict}`);
  console.log(` Risk score:  ${analysis.risk_assessment.score}/100`);
  console.log(` Price:       ${price.price_usd ? "$" + price.price_usd : "unlisted"}`);
  console.log(` Liquidity:   ${price.liquidity_usd ?? "unknown"}`);
  console.log(` Holders:     ${analysis.total_holders}`);
  console.log(` Top-10:      ${analysis.concentration.top_10_pct} of supply`);
  console.log(` Treasury:    ${treasury.account_age_days ?? "unknown"} days old`);
  console.log(` Balance:     ${treasury.payment?.remaining_hbar} ℏ remaining`);
  console.log("=".repeat(62) + "\n");

  // ── Save report ───────────────────────────────────────────────────────────
  if (SAVE) {
    const { writeFileSync } = await import("fs");
    const filename = `dd-report-${TOKEN_ID.replace(/\./g, "-")}.json`;
    writeFileSync(filename, JSON.stringify(report, null, 2));
    log(`Report saved to ${filename}`);
  }
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
