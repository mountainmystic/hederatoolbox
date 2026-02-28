// server.js - MCP server factory, registers all module tools
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HCS_TOOL_DEFINITIONS, executeHCSTool } from "./modules/hcs/tools.js";
import { COMPLIANCE_TOOL_DEFINITIONS, executeComplianceTool } from "./modules/compliance/tools.js";
import { GOVERNANCE_TOOL_DEFINITIONS, executeGovernanceTool } from "./modules/governance/tools.js";
import { TOKEN_TOOL_DEFINITIONS, executeTokenTool } from "./modules/token/tools.js";
import { IDENTITY_TOOL_DEFINITIONS, executeIdentityTool } from "./modules/identity/tools.js";
import { CONTRACT_TOOL_DEFINITIONS, executeContractTool } from "./modules/contract/tools.js";
import { NFT_TOOL_DEFINITIONS, executeNFTTool } from "./modules/nft/tools.js";
import { BRIDGE_TOOL_DEFINITIONS, executeBridgeTool } from "./modules/bridge/tools.js";

const ALL_TOOLS = [
  ...HCS_TOOL_DEFINITIONS,
  ...COMPLIANCE_TOOL_DEFINITIONS,
  ...GOVERNANCE_TOOL_DEFINITIONS,
  ...TOKEN_TOOL_DEFINITIONS,
  ...IDENTITY_TOOL_DEFINITIONS,
  ...CONTRACT_TOOL_DEFINITIONS,
  ...NFT_TOOL_DEFINITIONS,
  ...BRIDGE_TOOL_DEFINITIONS,
];

async function routeTool(name, args) {
  if (["hcs_monitor", "hcs_query", "hcs_understand"].includes(name)) {
    return executeHCSTool(name, args);
  }
  if (["hcs_write_record", "hcs_verify_record", "hcs_audit_trail"].includes(name)) {
    return executeComplianceTool(name, args);
  }
  if (["governance_monitor", "governance_analyze", "governance_vote"].includes(name)) {
    return executeGovernanceTool(name, args);
  }
  if (["token_price", "token_analyze", "defi_yields", "token_monitor"].includes(name)) {
    return executeTokenTool(name, args);
  }
  if (["identity_resolve", "identity_verify_kyc", "identity_check_sanctions"].includes(name)) {
    return executeIdentityTool(name, args);
  }
  if (["contract_read", "contract_call", "contract_analyze"].includes(name)) {
    return executeContractTool(name, args);
  }
  if (["nft_collection_info", "nft_token_metadata", "nft_collection_analyze", "token_holders"].includes(name)) {
    return executeNFTTool(name, args);
  }
  if (["bridge_status", "bridge_transfers", "bridge_analyze"].includes(name)) {
    return executeBridgeTool(name, args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createServer() {
  const server = new Server(
    { name: "hedera-mcp-platform", version: "1.6.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error("Tool: " + name);
    try {
      const result = await routeTool(name, args);
      console.error("Done: " + name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      console.error("Error: " + name + " - " + error.message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error.message,
              tool: name,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export { ALL_TOOLS };