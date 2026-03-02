// server-entry.js — Railway / HTTP server entry point (remote brain)
// This is what Railway runs. Contains all Hedera SDK logic.
// NOT shipped in the npm package (blocked by .npmignore).
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";
import { provisionKey, getAllAccounts, getRecentTransactions } from "./db.js";
import { startWatcher } from "./watcher.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";

const required = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "ANTHROPIC_API_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  return req.headers["x-admin-secret"] === secret;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const port = process.env.PORT || 3000;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(res, 200, {
      status: "ok",
      service: "HederaIntel — Hedera MCP Platform",
      version: "2.0.1",
      network: process.env.HEDERA_NETWORK,
      account: process.env.HEDERA_ACCOUNT_ID,
      modules: ["hcs", "compliance", "governance", "token", "identity", "contract", "nft", "bridge"],
      tools: ALL_TOOLS.map((t) => t.name),
      costs: getCosts(),
      mcp_endpoint: "/mcp",
      timestamp: new Date().toISOString(),
    });
  }

  if (url.pathname === "/mcp") {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

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

  if (req.method === "GET" && url.pathname === "/admin/accounts") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const accounts = getAllAccounts().map((a) => ({
      ...a,
      balance_hbar: (a.balance_tinybars / 100_000_000).toFixed(4),
    }));
    return json(res, 200, { accounts });
  }

  if (req.method === "GET" && url.pathname === "/admin/transactions") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { transactions: getRecentTransactions(100) });
  }

  return json(res, 404, { error: "Not found", mcp_endpoint: "/mcp" });
});

httpServer.listen(port, () => {
  console.error("HederaIntel remote brain running on port " + port);
  console.error("Health: http://localhost:" + port + "/");
  console.error("MCP:    http://localhost:" + port + "/mcp");
  if (process.env.ADMIN_SECRET) {
    console.error("Admin:  http://localhost:" + port + "/admin/* (secret set)");
  }
});

startWatcher();
console.error("Hedera network: " + process.env.HEDERA_NETWORK);
console.error("Tools: " + ALL_TOOLS.map((t) => t.name).join(", "));
