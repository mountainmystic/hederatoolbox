// index.js - Main entry point with stdio and Streamable HTTP transport
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";

function validateEnv() {
  const required = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "OPENAI_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Missing env vars: " + missing.join(", "));
    process.exit(1);
  }
}

function startHTTPServer() {
  const port = process.env.PORT || 3000;
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "Hedera MCP Platform",
        version: "1.6.0",
        network: process.env.HEDERA_NETWORK,
        account: process.env.HEDERA_ACCOUNT_ID,
        modules: ["hcs", "compliance", "governance", "token", "identity", "contract", "nft", "bridge"],
        tools: ALL_TOOLS.map((t) => t.name),
        costs: getCosts(),
        mcp_endpoint: "/mcp",
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname === "/mcp") {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", mcp_endpoint: "/mcp" }));
  });

  httpServer.listen(port, () => {
    console.error("HTTP server on port " + port);
    console.error("Health: http://localhost:" + port + "/");
    console.error("MCP:    http://localhost:" + port + "/mcp");
  });
}

async function main() {
  validateEnv();
  const isStdio = !process.env.PORT && process.stdin.isTTY === false;

  if (isStdio) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Hedera MCP Platform running (stdio)");
    console.error("Network: " + process.env.HEDERA_NETWORK);
    console.error("Tools: " + ALL_TOOLS.map(t => t.name).join(", "));
  } else {
    startHTTPServer();
    console.error("Hedera MCP Platform running (HTTP)");
    console.error("Network: " + process.env.HEDERA_NETWORK);
    console.error("Tools: " + ALL_TOOLS.map(t => t.name).join(", "));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});