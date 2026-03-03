// hitl.js — Human-in-the-Loop enforcement for HederaIntel
//
// HITL is scoped to irreversible on-chain write operations and runaway
// loop detection. It is NOT a general balance gate.
//
// Tiers:
//   hard_stop  — governance_vote: blocked until human approves via URL
//   notify     — hcs_write_record: executes immediately + webhook notification
//   loop_guard — any tool called >20 times in 60s by same api_key: blocked + alert
//   auto       — everything else: execute immediately, no HITL

import crypto from "crypto";
import axios from "axios";
import {
  createHITLEvent,
  getHITLEvent,
  markWebhookSent,
} from "./db.js";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

export const HITL_TIERS = {
  governance_vote:  "hard_stop",
  hcs_write_record: "notify",
};

const LOOP_WINDOW_MS = 60 * 1000; // 60 seconds
const LOOP_THRESHOLD = 20;        // calls within window before blocking

// In-memory call tracker for loop detection (resets on restart — intentional,
// loop guard is a live-session safety net, not a persistent quota)
const callLog = {}; // { "api_key:tool_name": [timestamp, ...] }

// ─────────────────────────────────────────────
// Loop detection
// ─────────────────────────────────────────────

function trackCall(apiKey, toolName) {
  const key = `${apiKey}:${toolName}`;
  const now = Date.now();
  if (!callLog[key]) callLog[key] = [];
  callLog[key] = callLog[key].filter(t => now - t < LOOP_WINDOW_MS);
  callLog[key].push(now);
  return callLog[key].length;
}

// ─────────────────────────────────────────────
// Webhook delivery
// ─────────────────────────────────────────────

async function sendWebhook(payload) {
  const url = process.env.HITL_WEBHOOK_URL;
  if (!url) return false;
  try {
    await axios.post(url, payload, { timeout: 5000 });
    return true;
  } catch (e) {
    console.error("[HITL] Webhook delivery failed:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// Main enforcement function
//
// Call this BEFORE executing any tool.
// Returns { proceed: true } if the tool should run.
// Returns { proceed: false, error: "..." } if blocked.
// ─────────────────────────────────────────────

export async function enforceHITL(toolName, apiKey, costHbar) {
  const baseUrl = process.env.APPROVAL_BASE_URL
    || "https://hedera-mcp-platform-production.up.railway.app";

  // ── Loop guard (applies to all tools) ───────────────────────────────────
  const callCount = trackCall(apiKey, toolName);
  if (callCount > LOOP_THRESHOLD) {
    await sendWebhook({
      event: "loop_detected",
      tool: toolName,
      api_key: apiKey,
      call_count: callCount,
      window_seconds: LOOP_WINDOW_MS / 1000,
      timestamp: new Date().toISOString(),
    });
    return {
      proceed: false,
      hitl_tier: "loop_guard",
      error:
        `Loop guard triggered: "${toolName}" has been called ${callCount} times in the last ` +
        `${LOOP_WINDOW_MS / 1000} seconds by this API key. ` +
        `Temporarily blocked to prevent runaway execution. ` +
        `Wait ${LOOP_WINDOW_MS / 1000} seconds and retry.`,
    };
  }

  const tier = HITL_TIERS[toolName];

  // ── Auto tier — no HITL needed ──────────────────────────────────────────
  if (!tier) return { proceed: true };

  // ── Hard stop — governance_vote ─────────────────────────────────────────
  if (tier === "hard_stop") {
    const approvalToken = crypto.randomUUID();
    const approvalUrl = `${baseUrl}/hitl/approve/${approvalToken}`;

    createHITLEvent(apiKey, toolName, costHbar, "hard_stop", approvalToken);

    await sendWebhook({
      event: "hard_stop",
      tool: toolName,
      api_key: apiKey,
      cost_hbar: costHbar,
      approval_url: approvalUrl,
      message: `Human approval required before ${toolName} can execute.`,
      timestamp: new Date().toISOString(),
    });

    return {
      proceed: false,
      hitl_tier: "hard_stop",
      approval_token: approvalToken,
      approval_url: approvalUrl,
      error:
        `HUMAN APPROVAL REQUIRED: "${toolName}" is an irreversible on-chain write operation. ` +
        `A human operator must approve this action before it can execute. ` +
        `Approval URL: ${approvalUrl} — ` +
        `Once approved, retry this tool call with the same parameters. ` +
        `Approval token: ${approvalToken}`,
    };
  }

  // ── Notify tier — hcs_write_record ──────────────────────────────────────
  if (tier === "notify") {
    const approvalToken = crypto.randomUUID();

    createHITLEvent(apiKey, toolName, costHbar, "notify", approvalToken);

    // Fire-and-forget — notify does NOT block execution
    sendWebhook({
      event: "notify",
      tool: toolName,
      api_key: apiKey,
      cost_hbar: costHbar,
      message: `Write operation "${toolName}" executed. Notification only — no approval required.`,
      timestamp: new Date().toISOString(),
    }).then(sent => {
      if (sent) markWebhookSent(approvalToken);
    });

    return { proceed: true, hitl_tier: "notify", notified: true };
  }

  return { proceed: true };
}

// ─────────────────────────────────────────────
// Check if a hard_stop event has been approved
// ─────────────────────────────────────────────

export function checkApproval(approvalToken) {
  const event = getHITLEvent(approvalToken);
  if (!event) return { approved: false, reason: "Token not found" };
  if (event.status === "approved") return { approved: true, event };
  return { approved: false, reason: "Pending human approval", event };
}
