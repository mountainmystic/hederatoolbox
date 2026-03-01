// modules/account/tools.js - Account info and onboarding tool
// This is the agent onboarding entrypoint. Free to call, no API key required.
// An agent that finds this MCP server for the first time calls this tool,
// gets the platform wallet address and pricing, sends HBAR, and is ready to go.

import { COSTS } from "../../payments.js";
import { getBalance, getAccount } from "../../db.js";

export const ACCOUNT_TOOL_DEFINITIONS = [
  {
    name: "account_info",
    description:
      "Get platform wallet address, pricing for all tools, and your current balance. " +
      "FREE to call — no API key required. " +
      "Use this tool first to discover how to fund an account and start using the platform. " +
      "To create an account automatically, simply send HBAR to the platform wallet — " +
      "your Hedera account ID becomes your API key within 30 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Optional. Your Hedera account ID (e.g. 0.0.456789) or API key. If provided, your current balance is returned.",
        },
      },
      required: [],
    },
  },
];

export async function executeAccountTool(name, args) {
  if (name === "account_info") {
    return getAccountInfo(args);
  }
  throw new Error(`Unknown account tool: ${name}`);
}

function getAccountInfo(args) {
  const { api_key } = args || {};

  // Build pricing table grouped by tier
  const pricing = Object.entries(COSTS).map(([tool, cost]) => ({
    tool,
    cost_hbar: cost.hbar,
  }));

  // Check balance if an api_key was provided
  let balanceInfo = null;
  if (api_key) {
    const account = getAccount(api_key);
    if (account) {
      balanceInfo = {
        api_key,
        balance_hbar: (account.balance_tinybars / 100_000_000).toFixed(4),
        hedera_account_id: account.hedera_account_id,
        created_at: account.created_at,
        last_used: account.last_used,
      };
    } else {
      balanceInfo = {
        api_key,
        balance_hbar: "0.0000",
        message: "Account not found. Send HBAR to the platform wallet to create your account automatically.",
      };
    }
  }

  return {
    service: "AgentLens — Hedera MCP Platform",
    description: "26 tools across 8 modules. Pay per call in HBAR. No registration required.",

    how_to_fund: {
      step_1: "Send any amount of HBAR to the platform wallet below.",
      step_2: "Your Hedera account ID becomes your API key automatically within 30 seconds.",
      step_3: "Pass your Hedera account ID as the api_key parameter in any tool call.",
      step_4: "Call account_info with your api_key at any time to check your balance.",
      minimum_deposit: "No minimum. Even 1 HBAR gives you many tool calls.",
      note: "Balances are persistent. Unused credit carries over indefinitely.",
    },

    platform_wallet: {
      account_id: process.env.HEDERA_ACCOUNT_ID,
      network: process.env.HEDERA_NETWORK || "mainnet",
      memo: "AgentLens deposit — your sending account ID becomes your API key",
    },

    pricing,

    ...(balanceInfo && { your_account: balanceInfo }),

    links: {
      mcp_endpoint: "https://hedera-mcp-platform-production.up.railway.app/mcp",
      npm: "https://www.npmjs.com/package/hedera-mcp-platform",
    },
  };
}
