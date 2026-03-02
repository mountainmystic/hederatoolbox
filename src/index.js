#!/usr/bin/env node
// index.js — HederaIntel thin client MCP server (npm entry point)
// Registers all 27 tool schemas and proxies every call to the remote brain.
// No @hashgraph/sdk. No private keys. No business logic.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { forwardToRemote } from "./proxy.js";

const server = new Server(
  { name: "hedera-mcp-platform", version: "2.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!TOOLS.find((t) => t.name === name)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown tool: '${name}'. Call 'account_info' (no api_key needed) to see all available tools.`,
      })}],
      isError: true,
    };
  }

  try {
    const resultText = await forwardToRemote(name, args || {});
    return { content: [{ type: "text", text: resultText }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: err.message,
        tool: name,
        hint: "Check your API key and balance with the 'account_info' tool.",
      })}],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const remote = process.env.HEDERAINTEL_ENDPOINT || "https://hedera-mcp-platform-production.up.railway.app";
console.error("[hedera-mcp-platform] connected | remote: " + remote + " | tools: " + TOOLS.length);
