// server.js - MCP server factory, registers all module tools
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HCS_TOOL_DEFINITIONS, executeHCSTool } from "./modules/hcs/tools.js";
import { COMPLIANCE_TOOL_DEFINITIONS, executeComplianceTool } from "./modules/compliance/tools.js";

const ALL_TOOLS = [
  ...HCS_TOOL_DEFINITIONS,
  ...COMPLIANCE_TOOL_DEFINITIONS,
];

async function routeTool(name, args) {
  if (["hcs_monitor", "hcs_query", "hcs_understand"].includes(name)) {
    return executeHCSTool(name, args);
  }
  if (["hcs_write_record", "hcs_verify_record", "hcs_audit_trail"].includes(name)) {
    return executeComplianceTool(name, args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createServer() {
  const server = new Server(
    { name: "hedera-mcp-platform", version: "1.0.0" },
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