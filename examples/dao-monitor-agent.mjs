/**
 * dao-monitor-agent.mjs — HederaToolbox DAO governance monitor
 *
 * Watches active governance proposals for a Hedera token on a schedule.
 * Alerts when a proposal is closing within your configured window.
 * Pass --analyze with a PROPOSAL_ID for deep vote tally and outcome prediction.
 *
 * Use cases: DAO members, large HBAR holders, governance councils, anyone
 * who wants to stop missing votes on Hedera governance proposals.
 *
 * Setup (one time):
 *   1. Send any amount of HBAR to the platform wallet: 0.0.10309126
 *      Your Hedera account ID becomes your API key automatically.
 *   2. Replace YOUR_HEDERA_ACCOUNT_ID below with your account ID.
 *   3. Set TOKEN_ID to your DAO governance token.
 *   4. node examples/dao-monitor-agent.mjs
 *
 * ⚠️  IMPORTANT: For proposal data you MUST provide a TOPIC_ID — the HCS topic
 *     where your DAO records governance messages. Without it, only token metadata
 *     is returned (no proposals). Your DAO documentation should list this topic.
 *
 *     Example Hedera ecosystem governance topics:
 *       Hedera mainnet governance: check https://hashscan.io for active topics
 *       SaucerSwap DAO: check https://saucerswap.finance/governance
 *
 * Cost: 0.2 ℏ per check · 1.0 ℏ for --analyze · 10 ℏ covers ~12 days at 4x/day
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY           = process.env.HEDERA_ACCOUNT_ID || "YOUR_HEDERA_ACCOUNT_ID";
const TOKEN_ID          = process.env.TOKEN_ID          || "0.0.731861";
const TOPIC_ID          = process.env.TOPIC_ID          || null;   // ⚠️ Set this for proposal data
const DEADLINE_ALERT_H  = parseInt(process.env.DEADLINE_ALERT_H   || "24");
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS  || "21600000"); // 6 hours
const ENDPOINT          = "https://api.hederatoolbox.com/mcp";
// ─────────────────────────────────────────────────────────────────────────────

if (API_KEY === "YOUR_HEDERA_ACCOUNT_ID") {
  console.error("\n❌ Replace API_KEY with your Hedera account ID (e.g. \"0.0.123456\").");
  console.error("   Send any HBAR to 0.0.10309126 first — your account ID becomes your key.\n");
  process.exit(1);
}

if (!TOPIC_ID) {
  console.warn("\n⚠️  No TOPIC_ID set. Proposal data will not be available.");
  console.warn("   Set TOPIC_ID to your DAO's HCS governance topic for full monitoring.");
  console.warn("   Example: TOPIC_ID=0.0.123456 node examples/dao-monitor-agent.mjs\n");
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
function sep(len = 62) { console.log("─".repeat(len)); }

function hoursUntil(deadlineStr) {
  if (!deadlineStr) return null;
  const deadline = new Date(deadlineStr);
  if (isNaN(deadline.getTime())) return null;
  return (deadline.getTime() - Date.now()) / (1000 * 60 * 60);
}

// ─── Onboard (free) ───────────────────────────────────────────────────────────
async function onboard() {
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

// ─── Deep analyze a specific proposal ────────────────────────────────────────
async function analyzeProposal() {
  const proposalId = process.env.PROPOSAL_ID;
  if (!proposalId) {
    console.error("❌ Set PROPOSAL_ID env var to use --analyze");
    console.error("   PROPOSAL_ID=42 TOPIC_ID=0.0.999 node examples/dao-monitor-agent.mjs --analyze");
    process.exit(1);
  }
  if (!TOPIC_ID) {
    console.error("❌ TOPIC_ID required for --analyze");
    process.exit(1);
  }

  log(`Running governance_analyze on proposal ${proposalId} (1.0 ℏ)...`);
  const analysis = await callTool("governance_analyze", {
    token_id: TOKEN_ID,
    proposal_id: proposalId,
    topic_id: TOPIC_ID,
  });

  console.log("\n" + "=".repeat(62));
  console.log(" PROPOSAL DEEP ANALYSIS");
  console.log("=".repeat(62));
  console.log(` Proposal:       ${analysis.proposal?.title ?? `#${proposalId}`}`);
  if (analysis.proposal?.description) {
    console.log(` Description:    ${analysis.proposal.description.slice(0, 80)}${analysis.proposal.description.length > 80 ? "…" : ""}`);
  }
  if (analysis.proposal?.deadline) {
    const h = hoursUntil(analysis.proposal.deadline);
    console.log(` Deadline:       ${new Date(analysis.proposal.deadline).toUTCString()}${h !== null ? ` (${h.toFixed(1)}h remaining)` : ""}`);
  }
  console.log(` Yes:            ${analysis.vote_tally.yes} (${analysis.vote_tally.yes_pct})`);
  console.log(` No:             ${analysis.vote_tally.no} (${analysis.vote_tally.no_pct})`);
  console.log(` Abstain:        ${analysis.vote_tally.abstain}`);
  console.log(` Total votes:    ${analysis.vote_tally.total}`);
  console.log(` Participation:  ${analysis.participation_rate}`);
  console.log(` Concentration:  ${analysis.token_concentration.top_5_holders_pct} held by top 5`);
  console.log(` Prediction:     ${analysis.outcome_prediction}`);
  if (analysis.token_concentration.note) {
    console.log(` Note:           ${analysis.token_concentration.note}`);
  }
  console.log("=".repeat(62) + "\n");
}

// ─── Monitoring cycle ─────────────────────────────────────────────────────────
async function runCycle(cycleNum) {
  log(`─── Cycle #${cycleNum} — ${TOKEN_ID}${TOPIC_ID ? ` · topic ${TOPIC_ID}` : " · no topic set"} ───`);

  const args = { token_id: TOKEN_ID };
  if (TOPIC_ID) args.topic_id = TOPIC_ID;

  const monitor = await callTool("governance_monitor", args);
  const remaining = monitor.payment?.remaining_hbar ?? "?";

  log(`${monitor.token_name} (${monitor.token_symbol}) | Active proposals: ${monitor.active_proposals} | Balance: ${remaining} ℏ`);
  log(monitor.summary);

  const proposals = monitor.proposals || [];

  if (proposals.length === 0) {
    if (!TOPIC_ID) {
      log(`ℹ️  No proposals found. Set TOPIC_ID for full governance monitoring.`);
    } else {
      log(`✅ No active proposals. Next check in ${CHECK_INTERVAL_MS / 3600000}h.`);
    }
    return;
  }

  // Print proposals
  console.log();
  sep();
  console.log(` ACTIVE PROPOSALS — ${monitor.token_name}`);
  sep();

  const urgent = [];

  for (const p of proposals) {
    const hours = hoursUntil(p.deadline);
    const deadlineStr = p.deadline
      ? `${new Date(p.deadline).toUTCString()} (${hours !== null ? hours.toFixed(1) + "h remaining" : "deadline set"})`
      : "No deadline set";

    const totalVotes = (p.yes_votes || 0) + (p.no_votes || 0) + (p.abstain_votes || 0);
    const yesPct = totalVotes > 0 ? ((p.yes_votes / totalVotes) * 100).toFixed(0) : "—";
    const noPct  = totalVotes > 0 ? ((p.no_votes  / totalVotes) * 100).toFixed(0) : "—";

    console.log(`\n Proposal #${p.proposal_id}: ${p.title}`);
    console.log(`   Status:    ${p.status}`);
    console.log(`   Deadline:  ${deadlineStr}`);
    console.log(`   Votes:     ✅ Yes ${p.yes_votes} (${yesPct}%)  ❌ No ${p.no_votes} (${noPct}%)  Abstain ${p.abstain_votes || 0}`);

    if (hours !== null && hours > 0 && hours <= DEADLINE_ALERT_H) {
      urgent.push({ ...p, hours_remaining: hours });
    }
  }

  // Deadline alerts
  if (urgent.length > 0) {
    console.log("\n" + "=".repeat(62));
    console.log(`  ⏰ DEADLINE ALERT — ${urgent.length} proposal(s) closing within ${DEADLINE_ALERT_H}h`);
    console.log("=".repeat(62));
    for (const p of urgent) {
      console.log(`\n  ⚠️  "${p.title}" closes in ${p.hours_remaining.toFixed(1)} hours`);
      console.log(`     Current: Yes ${p.yes_votes} / No ${p.no_votes} / Abstain ${p.abstain_votes || 0}`);
      if (TOPIC_ID) {
        console.log(`     Deep analysis:`);
        console.log(`     PROPOSAL_ID=${p.proposal_id} TOKEN_ID=${TOKEN_ID} TOPIC_ID=${TOPIC_ID} HEDERA_ACCOUNT_ID=${API_KEY} node examples/dao-monitor-agent.mjs --analyze`);
      }
    }
    console.log("\n" + "=".repeat(62) + "\n");
  } else {
    log(`✅ No proposals closing within ${DEADLINE_ALERT_H}h. Next check in ${CHECK_INTERVAL_MS / 3600000}h.\n`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(62));
  console.log("  HederaToolbox — DAO Governance Monitor");
  console.log(`  Token:     ${TOKEN_ID}`);
  console.log(`  Topic:     ${TOPIC_ID ?? "⚠️  not set — proposal data unavailable"}`);
  console.log(`  Alert:     closing within ${DEADLINE_ALERT_H}h`);
  console.log(`  Interval:  every ${CHECK_INTERVAL_MS / 3600000}h`);
  console.log("=".repeat(62) + "\n");

  await onboard();

  // One-shot analysis mode
  if (process.argv.includes("--analyze")) {
    await analyzeProposal();
    return;
  }

  log("Starting governance monitor...\n");
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
