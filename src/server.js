// server.js - MCP server factory with consent gate and HITL enforcement
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HCS_TOOL_DEFINITIONS, executeHCSTool } from "./modules/hcs/tools.js";
import { COMPLIANCE_TOOL_DEFINITIONS, executeComplianceTool } from "./modules/compliance/tools.js";
import { GOVERNANCE_TOOL_DEFINITIONS, executeGovernanceTool } from "./modules/governance/tools.js";
import { TOKEN_TOOL_DEFINITIONS, executeTokenTool } from "./modules/token/tools.js";
import { IDENTITY_TOOL_DEFINITIONS, executeIdentityTool } from "./modules/identity/tools.js";
import { CONTRACT_TOOL_DEFINITIONS, executeContractTool } from "./modules/contract/tools.js";
import { NFT_TOOL_DEFINITIONS, executeNFTTool } from "./modules/nft/tools.js";
import { ACCOUNT_TOOL_DEFINITIONS, executeAccountTool } from "./modules/account/tools.js";
import { LEGAL_TOOL_DEFINITIONS, executeLegalTool } from "./modules/legal/tools.js";
import { checkConsent } from "./consent.js";

export const ALL_TOOLS = [
  // Legal / onboarding (always first — agents see these before any paid tool)
  ...LEGAL_TOOL_DEFINITIONS,
  ...ACCOUNT_TOOL_DEFINITIONS,
  // Paid tools
  ...HCS_TOOL_DEFINITIONS,
  ...COMPLIANCE_TOOL_DEFINITIONS,
  ...GOVERNANCE_TOOL_DEFINITIONS,
  ...TOKEN_TOOL_DEFINITIONS,
  ...IDENTITY_TOOL_DEFINITIONS,
  ...CONTRACT_TOOL_DEFINITIONS,
  ...NFT_TOOL_DEFINITIONS,
];

// Tools that bypass consent + HITL entirely
const FREE_TOOLS = new Set(["account_info", "get_terms", "confirm_terms"]);

async function routeTool(name, args, req) {
  // Legal tools (no consent check — they ARE the consent flow)
  if (["get_terms", "confirm_terms"].includes(name)) return executeLegalTool(name, args, req);
  if (name === "account_info") return executeAccountTool(name, args);

  // ── Consent gate ─────────────────────────────────────────────────────────
  checkConsent(name, args);

  // ── Execute tool ──────────────────────────────────────────────────────────
  let result;
  if (["hcs_monitor", "hcs_query", "hcs_understand"].includes(name)) {
    result = await executeHCSTool(name, args);
  } else if (["hcs_write_record", "hcs_verify_record", "hcs_audit_trail"].includes(name)) {
    result = await executeComplianceTool(name, args);
  } else if (["governance_monitor", "governance_analyze", "governance_vote"].includes(name)) {
    result = await executeGovernanceTool(name, args);
  } else if (["token_price", "token_analyze", "defi_yields", "token_monitor"].includes(name)) {
    result = await executeTokenTool(name, args);
  } else if (["identity_resolve", "identity_verify_kyc", "identity_check_sanctions"].includes(name)) {
    result = await executeIdentityTool(name, args);
  } else if (["contract_read", "contract_call", "contract_analyze"].includes(name)) {
    result = await executeContractTool(name, args);
  } else if (["nft_collection_info", "nft_token_metadata", "nft_collection_analyze", "token_holders"].includes(name)) {
    result = await executeNFTTool(name, args);
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  return result;
}

export function createServer(req) {
  const server = new Server(
    { name: "hedera-mcp-platform", version: "2.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[Tool] ${name} | key: ${args?.api_key || "none"}`);

    try {
      const result = await routeTool(name, args, req);
      console.error(`[Done] ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      console.error(`[Error] ${name}: ${error.message}`);

      // HITL hard-stop — structured 403 response
      if (error.hitl) {
        return {
          content: [{ type: "text", text: JSON.stringify(error.hitl, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error.message,
            tool: name,
            timestamp: new Date().toISOString(),
          }),
        }],
        isError: true,
      };
    }
  });

  return server;
}
