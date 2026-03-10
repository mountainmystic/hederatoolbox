#!/usr/bin/env node
// index.js — HederaToolbox thin client MCP server (npm entry point)
// Registers all 27 tool schemas and proxies every call to the remote brain.
// No @hashgraph/sdk. No private keys. No business logic.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { forwardToRemote } from "./proxy.js";

const server = new Server(
  { name: "hederatoolbox", version: "3.2.0" },
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

const remote = process.env.HEDERATOOLBOX_ENDPOINT || "https://api.hederatoolbox.com";
console.error("[hederatoolbox] connected | remote: " + remote + " | tools: " + TOOLS.length);
