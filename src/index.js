// index.js - Main entry point with stdio and Streamable HTTP transport
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";
import { provisionKey, getAllAccounts, getRecentTransactions } from "./db.js";
import { startWatcher } from "./watcher.js";

function validateEnv() {
  const required = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "OPENAI_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Missing env vars: " + missing.join(", "));
    process.exit(1);
  }
}

// Read the full request body as a string
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Check admin secret header — set ADMIN_SECRET in your .env
function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false; // admin routes disabled if no secret set
  return req.headers["x-admin-secret"] === secret;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function startHTTPServer() {
  const port = process.env.PORT || 3000;

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // ── Health / status ──────────────────────────────────────────────────
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json(res, 200, {
        status: "ok",
        service: "Hedera MCP Platform",
        version: "1.6.3",
        network: process.env.HEDERA_NETWORK,
        account: process.env.HEDERA_ACCOUNT_ID,
        modules: ["hcs", "compliance", "governance", "token", "identity", "contract", "nft", "bridge"],
        tools: ALL_TOOLS.map((t) => t.name),
        costs: getCosts(),
        mcp_endpoint: "/mcp",
        timestamp: new Date().toISOString(),
      });
    }

    // ── MCP endpoint ─────────────────────────────────────────────────────
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

    // ── Admin: provision a key ────────────────────────────────────────────
    // POST /admin/provision
    // Headers: x-admin-secret: <your ADMIN_SECRET>
    // Body: { "api_key": "some-key", "hbar": 10, "hedera_account_id": "0.0.123" }
    if (req.method === "POST" && url.pathname === "/admin/provision") {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      try {
        const body = JSON.parse(await readBody(req));
        const { api_key, hbar, hedera_account_id } = body;
        if (!api_key || !hbar) return json(res, 400, { error: "api_key and hbar are required" });
        const tinybars = Math.round(Number(hbar) * 100_000_000);
        const account = provisionKey(api_key, tinybars, hedera_account_id || null);
        return json(res, 200, {
          success: true,
          api_key: account.api_key,
          balance_hbar: (account.balance_tinybars / 100_000_000).toFixed(4),
          hedera_account_id: account.hedera_account_id,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // ── Admin: list all accounts ──────────────────────────────────────────
    // GET /admin/accounts
    if (req.method === "GET" && url.pathname === "/admin/accounts") {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      const accounts = getAllAccounts().map((a) => ({
        ...a,
        balance_hbar: (a.balance_tinybars / 100_000_000).toFixed(4),
      }));
      return json(res, 200, { accounts });
    }

    // ── Admin: recent transactions ────────────────────────────────────────
    // GET /admin/transactions
    if (req.method === "GET" && url.pathname === "/admin/transactions") {
      if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
      const txs = getRecentTransactions(100);
      return json(res, 200, { transactions: txs });
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    return json(res, 404, { error: "Not found", mcp_endpoint: "/mcp" });
  });

  httpServer.listen(port, () => {
    console.error("HTTP server on port " + port);
    console.error("Health: http://localhost:" + port + "/");
    console.error("MCP:    http://localhost:" + port + "/mcp");
    if (process.env.ADMIN_SECRET) {
      console.error("Admin:  http://localhost:" + port + "/admin/* (secret set)");
    } else {
      console.error("Admin:  disabled (set ADMIN_SECRET in .env to enable)");
    }
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
    startWatcher();
    console.error("Hedera MCP Platform running (HTTP)");
    console.error("Network: " + process.env.HEDERA_NETWORK);
    console.error("Tools: " + ALL_TOOLS.map(t => t.name).join(", "));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
