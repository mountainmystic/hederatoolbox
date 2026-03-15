/**
 * compliance-onboarding-agent.mjs — HederaToolbox compliance onboarding agent
 *
 * Screens a Hedera account before doing business with them.
 * Runs identity resolution, sanctions screening, and optional KYC verification,
 * then writes a tamper-proof compliance record to the Hedera blockchain
 * and verifies the record was not tampered with.
 *
 * Use cases: token issuers, exchanges, regulated businesses, counterparty screening.
 *
 * Setup (one time):
 *   1. Send any amount of HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key automatically.
 *   2. Replace YOUR_HEDERA_ACCOUNT_ID below with your account ID.
 *   3. node examples/compliance-onboarding-agent.mjs
 *      Or: SUBJECT=0.0.999999 node examples/compliance-onboarding-agent.mjs
 *
 * Cost per onboarding:
 *   ~6.2 ℏ base (identity_resolve 0.2 + identity_check_sanctions 1.0 + hcs_write_record 5.0)
 *   + 1.0 ℏ for hcs_verify_record (tamper check)
 *   + 0.5 ℏ optional KYC check
 *   Total: ~7.2 ℏ with verify, ~7.7 ℏ with KYC
 *   Load 10 ℏ to get started.
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY       = process.env.HEDERA_ACCOUNT_ID || "YOUR_HEDERA_ACCOUNT_ID";
const SUBJECT_ID    = process.env.SUBJECT           || "0.0.7925398";  // account to screen
const KYC_TOKEN_ID  = process.env.KYC_TOKEN_ID      || null;           // optional: your token ID
const VERIFY_RECORD = process.env.SKIP_VERIFY !== "true";              // set SKIP_VERIFY=true to skip
const ENDPOINT      = "https://api.hederatoolbox.com/mcp";
const HASHSCAN_BASE = "https://hashscan.io/mainnet/transaction";
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

// ─── Onboard (free) ───────────────────────────────────────────────────────────
async function onboard() {
  await callTool("get_terms", {});
  await callTool("confirm_terms", { consent: true });
  const info = await callTool("account_info", {});
  log(`Account: ${API_KEY} | Balance: ${info.balance_hbar} ℏ`);
  const needed = VERIFY_RECORD ? (KYC_TOKEN_ID ? 7.7 : 7.2) : (KYC_TOKEN_ID ? 6.7 : 6.2);
  if (parseFloat(info.balance_hbar) < needed) {
    console.error(`\n❌ Insufficient balance: ${info.balance_hbar} ℏ (need ~${needed} ℏ)`);
    console.error(`   Top up: send HBAR to ${info.platform_wallet}\n`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox — Compliance Onboarding Agent");
  console.log(`  Screening: ${SUBJECT_ID}`);
  if (KYC_TOKEN_ID) console.log(`  KYC token: ${KYC_TOKEN_ID}`);
  console.log(`  Verify record: ${VERIFY_RECORD ? "yes (tamper check)" : "skipped"}`);
  console.log("=".repeat(62) + "\n");

  await onboard();
  log("Starting compliance workflow...\n");

  // ── Step 1: Identity resolution ──────────────────────────────────────────
  log("Step 1 — Resolving identity (0.2 ℏ)...");
  const identity = await callTool("identity_resolve", { account_id: SUBJECT_ID });

  sep();
  console.log(" IDENTITY PROFILE");
  sep();
  console.log(` Account:        ${identity.account_id}`);
  console.log(` Age:            ${identity.account_age_days ?? "unknown"} days`);
  console.log(` HBAR balance:   ${identity.hbar_balance}`);
  console.log(` Tokens held:    ${identity.token_count}`);
  console.log(` NFTs held:      ${identity.nft_count}`);
  console.log(` Tx sample:      ${identity.recent_transaction_count} recent transactions`);
  console.log(` Summary:        ${identity.identity_summary}`);

  // ── Step 2: Sanctions screening ──────────────────────────────────────────
  log("\nStep 2 — Sanctions screening (1.0 ℏ)...");
  const sanctions = await callTool("identity_check_sanctions", { account_id: SUBJECT_ID });

  sep();
  console.log(" SANCTIONS SCREENING");
  sep();
  console.log(` Result:         ${sanctions.screening_result}`);
  console.log(` Risk level:     ${sanctions.risk_level} (score: ${sanctions.risk_score}/100)`);
  console.log(` Signals:`);
  sanctions.risk_signals.forEach(s => console.log(`   • ${s}`));
  console.log(` Counterparties: ${sanctions.account_profile.unique_counterparties} sampled`);
  console.log(` Failed txs:     ${sanctions.account_profile.failed_transactions}`);

  // ── Step 3: KYC check (optional) ─────────────────────────────────────────
  let kycResult = null;
  if (KYC_TOKEN_ID) {
    log("\nStep 3 — KYC verification (0.5 ℏ)...");
    kycResult = await callTool("identity_verify_kyc", {
      account_id: SUBJECT_ID,
      token_id: KYC_TOKEN_ID,
    });
    sep();
    console.log(" KYC VERIFICATION");
    sep();
    console.log(` Token:          ${KYC_TOKEN_ID}`);
    console.log(` Status:         ${kycResult.kyc_details[0]?.kyc_status ?? "NOT_APPLICABLE"}`);
    console.log(` Note:           ${kycResult.note}`);
  }

  // ── Determine overall result ──────────────────────────────────────────────
  const overallResult =
    sanctions.screening_result === "FLAGGED"                     ? "REJECTED"
    : sanctions.screening_result === "REVIEW"                    ? "PENDING_REVIEW"
    : kycResult && !kycResult.kyc_details[0]?.kyc_granted        ? "PENDING_KYC"
    : "APPROVED";

  // ── Step 4: Write compliance record to HCS ───────────────────────────────
  const writeStep = KYC_TOKEN_ID ? "4" : "3";
  log(`\nStep ${writeStep} — Writing compliance record to Hedera HCS (5 ℏ)...`);

  const record = await callTool("hcs_write_record", {
    record_type: "compliance_onboarding",
    entity_id: SUBJECT_ID,
    data: {
      subject_account: SUBJECT_ID,
      screened_by: API_KEY,
      onboarding_result: overallResult,
      identity_summary: identity.identity_summary,
      account_age_days: identity.account_age_days,
      sanctions_result: sanctions.screening_result,
      risk_level: sanctions.risk_level,
      risk_score: sanctions.risk_score,
      risk_signals: sanctions.risk_signals,
      kyc_checked: !!KYC_TOKEN_ID,
      kyc_token: KYC_TOKEN_ID || null,
      kyc_status: kycResult?.kyc_details[0]?.kyc_status || null,
      agent: "compliance-onboarding-agent",
    },
  });

  // ── Step 5: Verify the record was written correctly ───────────────────────
  let verified = null;
  if (VERIFY_RECORD) {
    const verifyStep = parseInt(writeStep) + 1;
    log(`\nStep ${verifyStep} — Verifying record on-chain (1.0 ℏ)...`);
    // Brief wait for consensus
    await new Promise(r => setTimeout(r, 3000));
    verified = await callTool("hcs_verify_record", {
      record_id: record.record_id,
    });
  }

  // ── Final report ─────────────────────────────────────────────────────────
  const icon = overallResult === "APPROVED" ? "✅" : overallResult === "REJECTED" ? "❌" : "⚠️ ";

  console.log("\n" + "=".repeat(62));
  console.log(`  ${icon} ONBOARDING RESULT: ${overallResult}`);
  console.log("=".repeat(62));
  console.log(` Subject:        ${SUBJECT_ID}`);
  console.log(` Identity:       ${identity.identity_summary}`);
  console.log(` Sanctions:      ${sanctions.screening_result} (${sanctions.risk_level} risk, score: ${sanctions.risk_score}/100)`);
  if (KYC_TOKEN_ID) {
    console.log(` KYC:            ${kycResult?.kyc_details[0]?.kyc_status ?? "NOT_APPLICABLE"}`);
  }
  console.log(` HCS Record ID:  ${record.record_id}`);
  console.log(` Transaction ID: ${record.transaction_id}`);
  console.log(` On-chain proof: ${HASHSCAN_BASE}/${record.transaction_id}`);
  if (verified) {
    console.log(` Record verified: ${verified.verified ? "✅ intact, not tampered" : "❌ TAMPER DETECTED"}`);
  }
  console.log(` Balance after:  ${verified?.payment?.remaining_hbar ?? record.payment?.remaining_hbar} ℏ`);
  console.log("=".repeat(62));

  if (overallResult === "REJECTED") {
    console.log("\n  ⛔ Account flagged. Do not proceed.");
  } else if (overallResult === "PENDING_REVIEW") {
    console.log("\n  ⚠️  Manual review required before onboarding.");
  } else if (overallResult === "PENDING_KYC") {
    console.log("\n  ℹ️  KYC not granted. Grant KYC before allowing token interactions.");
  } else {
    console.log("\n  ✅ Account cleared for onboarding.");
  }
  console.log();
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
