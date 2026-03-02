// hitl.js — Human-in-the-Loop enforcement middleware
//
// Tier thresholds (HBAR value of the transaction being requested):
//   AUTO_APPROVE  : < 500 HBAR   → execute immediately
//   NOTIFY_ONLY   : 500–5000 HBAR → execute, then fire webhook
//   HARD_STOP     : > 10,000 HBAR → block, return 403 with approval URL
//
// Admin operations (updateAdminKey etc.) always trigger HARD_STOP regardless of value.
//
// For our current tool set, HBAR amounts are small (max 2 HBAR per call).
// This middleware is forward-looking for when governance_vote or hcs_write_record
// are used in high-value automated workflows, and for future large-transfer tools.

import crypto from "crypto";
import { createHITLEvent, markWebhookSent } from "./db.js";

// HITL thresholds in HBAR
const TIER = {
  AUTO_APPROVE: 500,
  NOTIFY_ONLY_MAX: 5000,
  HARD_STOP: 10_000,
};

// Administrative operations that always require human approval
const ADMIN_OPS = new Set([
  "updateAdminKey",
  "deleteAccount",
  "freezeAccount",
  "wipeAccount",
]);

// Tools that carry write/value risk — map to their HBAR cost for HITL evaluation
// Most tools cost < 2 HBAR so they auto-approve. This is ready for future high-value tools.
const TOOL_HBAR_VALUE = {
  hcs_write_record:  2.0,
  governance_vote:   2.0,
  hcs_audit_trail:   1.0,
  contract_analyze:  1.0,
  contract_call:     0.5,
  hcs_understand:    0.5,
  hcs_verify_record: 0.5,
  governance_analyze: 0.5,
  identity_check_sanctions: 0.5,
  bridge_analyze:    0.5,
  // All others default to their HBAR cost (< 0.3 HBAR) → always AUTO_APPROVE
};

const APPROVAL_BASE_URL = process.env.APPROVAL_BASE_URL || "https://hedera-mcp-platform-production.up.railway.app";
const WEBHOOK_URL = process.env.HITL_WEBHOOK_URL || null;

/**
 * Evaluate HITL tier for a tool call.
 * Returns null for AUTO_APPROVE.
 * Returns { tier: "NOTIFY_ONLY", approvalToken } for notify tier (call proceeds, webhook fires async).
 * Throws a structured error object for HARD_STOP.
 *
 * @param {string} toolName
 * @param {string} apiKey
 * @param {object} args
 * @returns {object|null}
 */
export async function checkHITL(toolName, apiKey, args) {
  const hbarValue = TOOL_HBAR_VALUE[toolName] ?? 0.1;
  const isAdminOp = args?.function_name && ADMIN_OPS.has(args.function_name);

  // HARD STOP: admin operations or value > threshold
  if (isAdminOp || hbarValue > TIER.HARD_STOP) {
    const approvalToken = crypto.randomUUID();
    const approvalUrl = `${APPROVAL_BASE_URL}/hitl/approve/${approvalToken}`;

    createHITLEvent(apiKey, toolName, hbarValue, "HARD_STOP", approvalToken);

    const err = new Error("HUMAN_APPROVAL_REQUIRED");
    err.hitl = {
      status: 403,
      tier: "HARD_STOP",
      reason: isAdminOp
        ? `Administrative operation '${args.function_name}' requires human approval.`
        : `Transaction value ${hbarValue} HBAR exceeds the ${TIER.HARD_STOP} HBAR hard-stop threshold.`,
      approval_url: approvalUrl,
      approval_token: approvalToken,
      instruction: "A human operator must approve this action at the URL above before it can execute.",
    };
    throw err;
  }

  // NOTIFY ONLY: value in notify range
  if (hbarValue >= TIER.AUTO_APPROVE) {
    const approvalToken = crypto.randomUUID();
    createHITLEvent(apiKey, toolName, hbarValue, "NOTIFY_ONLY", approvalToken);

    // Fire webhook asynchronously — don't block the tool call
    if (WEBHOOK_URL) {
      fireWebhook(approvalToken, apiKey, toolName, hbarValue).catch((e) =>
        console.error("[HITL] Webhook failed:", e.message)
      );
    }

    return { tier: "NOTIFY_ONLY", approvalToken };
  }

  // AUTO APPROVE: value < threshold, not an admin op
  return null;
}

async function fireWebhook(approvalToken, apiKey, toolName, hbarValue) {
  const payload = {
    event: "hitl_notify",
    tier: "NOTIFY_ONLY",
    api_key: apiKey,
    tool: toolName,
    amount_hbar: hbarValue,
    approval_token: approvalToken,
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok) {
    markWebhookSent(approvalToken);
    console.error(`[HITL] Webhook sent for token ${approvalToken}`);
  } else {
    console.error(`[HITL] Webhook HTTP ${res.status} for token ${approvalToken}`);
  }
}
