/**
 * index.js — Dual-mode entry point
 *
 * ┌─ When PORT is set (Railway / HTTP mode) ──────────────────────────────┐
 * │  Runs the FULL remote brain server:                                    │
 * │  → All Hedera SDK logic, payments, SQLite, watcher                    │
 * │  → This is what Railway deploys                                        │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ When PORT is NOT set (stdio / npm mode) ──────────────────────────────┐
 * │  Runs the THIN CLIENT proxy:                                           │
 * │  → No SDK, no private keys, no business logic                         │
 * │  → Registers tool schemas, forwards every call to HEDERAINTEL_ENDPOINT│
 * │  → This is what npx users get                                          │
 * └───────────────────────────────────────────────────────────────────────┘
 */

// ─── HTTP / Railway mode (full server) ────────────────────────────────────

if (process.env.PORT) {
  // Only import heavy server-side deps when running as the remote brain.
  // This keeps the npm thin-client path free of SDK imports.
  const { default: dotenv } = await import("dotenv");
  dotenv.config();

  const { createServer, ALL_TOOLS } = await import("./server.js");
  const { getCosts } = await import("./payments.js");
  const { provisionKey, getAllAccounts, getRecentTransactions } = await import("./db.js");
  const { startWatcher } = await import("./watcher.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { default: http } = await import("http");

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
        version: "2.0.0",
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

} else {

  // ─── stdio / npm thin-client mode ─────────────────────────────────────────
  // No SDK. No private keys. Schemas + proxy only.

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  const { TOOLS } = await import("./tools.js");
  const { forwardToRemote } = await import("./proxy.js");

  const server = new Server(
    { name: "hedera-mcp-platform", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const toolDef = TOOLS.find((t) => t.name === name);
    if (!toolDef) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Unknown tool: '${name}'. Call 'account_info' (no api_key needed) to see all available tools.`,
          }),
        }],
        isError: true,
      };
    }

    try {
      const resultText = await forwardToRemote(name, args || {});
      return { content: [{ type: "text", text: resultText }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: err.message,
            tool: name,
            hint: "Check your API key and balance with the 'account_info' tool.",
          }),
        }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const remote = process.env.HEDERAINTEL_ENDPOINT || "https://hedera-mcp-platform-production.up.railway.app";
  console.error("[hedera-mcp-platform] stdio transport connected");
  console.error("[hedera-mcp-platform] Remote brain: " + remote);
  console.error("[hedera-mcp-platform] Tools registered: " + TOOLS.length);
}
