// server-entry.js — Railway / HTTP server entry point (remote brain)
// This is what Railway runs. Contains all Hedera SDK logic.
// NOT shipped in the npm package (blocked by .npmignore).
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";
import { provisionKey, getAllAccounts, getRecentTransactions, checkRateLimit, purgeOldConsentPII } from "./db.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS = JSON.parse(readFileSync(path.join(__dirname, "../legal/terms.json"), "utf-8"));
const { version: VERSION } = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
import { startWatcher } from "./watcher.js";
import { handleTelegramUpdate, registerWebhook } from "./telegram.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";

const required = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "ANTHROPIC_API_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}

const MAX_BODY_BYTES = 1_048_576; // 1MB — reject anything larger before full read

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error("Request body too large"), { code: 413 }));
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  // Header-only auth — ?secret= URL param removed (leaks to server logs)
  return req.headers["x-admin-secret"] === secret;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const port = process.env.PORT || 3000;
const startTime = Date.now();

// ── Rate limiter for free endpoints ──────────────────────────────────────────
// Simple in-memory store: ip -> { count, windowStart }
// SQLite-backed — survives restarts. Logic in db.js checkRateLimit().

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  // Wrap entire handler to catch 413 from readBody()
  req.on("error", (e) => {
    if (!res.headersSent) json(res, 413, { error: "Request body too large. Maximum size is 1MB." });
  });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(res, 200, {
      status: "ok",
      service: "HederaToolbox — Hedera MCP Platform",
      version: VERSION,
      network: process.env.HEDERA_NETWORK,
      account: process.env.HEDERA_ACCOUNT_ID,
      watcher_running: !!process.env.HEDERA_ACCOUNT_ID,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      modules: ["hcs", "compliance", "governance", "token", "identity", "contract"],
      tools: ALL_TOOLS.map((t) => t.name),
      costs: getCosts(),
      mcp_endpoint: "/mcp",
      terms_endpoint: "/terms",
      timestamp: new Date().toISOString(),
    });
  }

  // Public terms endpoint — agents and browsers can fetch this directly
  if (req.method === "GET" && url.pathname === "/terms") {
    return json(res, 200, TERMS);
  }

  // Rate limit free MCP onboarding endpoints
  if (["get_terms", "confirm_terms", "account_info"].some(t => url.pathname.includes(t))) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    if (checkRateLimit(ip)) {
      return json(res, 429, { error: "Rate limit exceeded. Max 30 requests per 60 seconds.", retry_after_seconds: 60 });
    }
  }

  // Serve static files from /public (e.g. /public/terms.json)
  if (req.method === "GET" && url.pathname.startsWith("/public/")) {
    const filename = url.pathname.replace("/public/", "");
    const staticPath = path.join(__dirname, "../public", filename);
    try {
      const content = readFileSync(staticPath, "utf-8");
      const ct = filename.endsWith(".json") ? "application/json" : "text/plain";
      res.writeHead(200, { "Content-Type": ct });
      res.end(content);
    } catch {
      return json(res, 404, { error: "File not found" });
    }
    return;
  }

  // Telegram webhook — Telegram POSTs incoming messages here
  if (req.method === "POST" && url.pathname === "/telegram/webhook") {
    try {
      const body = JSON.parse(await readBody(req));
      handleTelegramUpdate(body).catch(e => console.error("[Telegram] Update error:", e.message));
    } catch (e) {
      console.error("[Telegram] Webhook parse error:", e.message);
    }
    // Always respond 200 immediately — Telegram will retry if we don't
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
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

  if (req.method === "GET" && url.pathname === "/admin/stats") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { db } = await import("./db.js");
    const toolRanking = db.prepare(`
      SELECT tool_name, COUNT(*) as call_count, SUM(amount_tinybars) as total_tinybars
      FROM transactions
      GROUP BY tool_name
      ORDER BY call_count DESC
    `).all();
    const dailyVolume = db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
      FROM transactions
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
      LIMIT 30
    `).all();
    const totalCalls = db.prepare(`SELECT COUNT(*) as n FROM transactions`).get();
    const totalAccounts = db.prepare(`SELECT COUNT(*) as n FROM accounts`).get();
    const totalDeposits = db.prepare(`SELECT SUM(amount_tinybars) as n FROM deposits`).get();
    const watcherStatus = {
      platform_account: process.env.HEDERA_ACCOUNT_ID,
      network: process.env.HEDERA_NETWORK,
      poll_interval_seconds: 10,
      status: "running",
    };
    return json(res, 200, {
      watcher: watcherStatus,
      summary: {
        total_calls: totalCalls.n,
        total_accounts: totalAccounts.n,
        total_deposited_hbar: ((totalDeposits.n || 0) / 100_000_000).toFixed(4),
      },
      tool_ranking: toolRanking.map(r => ({
        tool: r.tool_name,
        calls: r.call_count,
        revenue_hbar: (r.total_tinybars / 100_000_000).toFixed(4),
      })),
      daily_volume: dailyVolume.map(d => ({
        date: d.date,
        calls: d.calls,
        revenue_hbar: (d.tinybars / 100_000_000).toFixed(4),
      })),
    });
  }

  // Analytics endpoint — revenue chart, top spenders, tool trends, monthly comparison
  if (req.method === "GET" && url.pathname === "/admin/analytics") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    const { db } = await import("./db.js");

    const dailyRevenue = db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
      FROM transactions
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `).all();

    const thisMonth = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(amount_tinybars),0) as tinybars
      FROM transactions
      WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
    `).get();
    const lastMonth = db.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(amount_tinybars),0) as tinybars
      FROM transactions
      WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', datetime('now', '-1 month'))
    `).get();

    const topSpenders = db.prepare(`
      SELECT api_key, COUNT(*) as calls, SUM(amount_tinybars) as tinybars
      FROM transactions GROUP BY api_key ORDER BY tinybars DESC LIMIT 10
    `).all();

    const toolTrends = db.prepare(`
      SELECT tool_name,
        SUM(CASE WHEN timestamp >= datetime('now','-7 days') THEN 1 ELSE 0 END) as calls_7d,
        SUM(CASE WHEN timestamp >= datetime('now','-14 days') AND timestamp < datetime('now','-7 days') THEN 1 ELSE 0 END) as calls_prev_7d
      FROM transactions WHERE timestamp >= datetime('now','-14 days')
      GROUP BY tool_name ORDER BY calls_7d DESC
    `).all();

    const avgCalls = db.prepare(`
      SELECT ROUND(CAST(COUNT(*) AS FLOAT) / MAX(1, (SELECT COUNT(*) FROM accounts)), 1) as avg
      FROM transactions
    `).get();

    const rateLimitHits = db.prepare(`SELECT COUNT(*) as n FROM rate_limits WHERE count >= 30`).get();

    const newAccounts30d = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as n
      FROM accounts WHERE created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at) ORDER BY date ASC
    `).all();

    const xagentKey = process.env.XAGENT_API_KEY;
    let xagent = null;
    if (xagentKey) {
      const xacc = db.prepare(`SELECT * FROM accounts WHERE api_key = ?`).get(xagentKey);
      const xspend = db.prepare(`
        SELECT COALESCE(SUM(amount_tinybars),0) as tinybars, COUNT(*) as calls
        FROM transactions WHERE api_key = ? AND timestamp >= datetime('now','-24 hours')
      `).get(xagentKey);
      if (xacc) xagent = {
        balance_hbar: (xacc.balance_tinybars / 100_000_000).toFixed(4),
        last_used: xacc.last_used,
        calls_24h: xspend.calls,
        spent_24h_hbar: (xspend.tinybars / 100_000_000).toFixed(4),
      };
    }

    return json(res, 200, {
      daily_revenue: dailyRevenue.map(d => ({ date: d.date, calls: d.calls, hbar: (d.tinybars / 100_000_000).toFixed(4) })),
      monthly: {
        this_month: { calls: thisMonth.calls, hbar: (thisMonth.tinybars / 100_000_000).toFixed(4) },
        last_month: { calls: lastMonth.calls, hbar: (lastMonth.tinybars / 100_000_000).toFixed(4) },
      },
      top_spenders: topSpenders.map(s => ({ api_key: s.api_key, calls: s.calls, hbar: (s.tinybars / 100_000_000).toFixed(4) })),
      tool_trends: toolTrends,
      avg_calls_per_account: avgCalls.avg || 0,
      rate_limit_hits_24h: rateLimitHits.n,
      new_accounts_30d: newAccounts30d,
      xagent,
    });
  }

  // GDPR delete — removes all rows for a given api_key
  if (req.method === "DELETE" && url.pathname === "/admin/delete-account") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    try {
      const body = JSON.parse(await readBody(req));
      const { api_key } = body;
      if (!api_key) return json(res, 400, { error: "api_key required" });
      const { db } = await import("./db.js");
      const account = db.prepare(`SELECT hedera_account_id FROM accounts WHERE api_key = ?`).get(api_key);
      if (!account) return json(res, 404, { error: "Account not found" });
      db.exec("BEGIN");
      try {
        const txDel  = db.prepare(`DELETE FROM transactions WHERE api_key = ?`).run(api_key);
        const ceDel  = db.prepare(`DELETE FROM consent_events WHERE api_key = ?`).run(api_key);
        const depDel = account.hedera_account_id
          ? db.prepare(`DELETE FROM deposits WHERE hedera_account_id = ?`).run(account.hedera_account_id)
          : { changes: 0 };
        const accDel = db.prepare(`DELETE FROM accounts WHERE api_key = ?`).run(api_key);
        db.exec("COMMIT");
        console.error(`[Admin] Deleted account ${api_key}`);
        return json(res, 200, { success: true, deleted: { transactions: txDel.changes, consent_events: ceDel.changes, deposits: depDel.changes, accounts: accDel.changes } });
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "GET" && url.pathname === "/admin/dashboard") {
    // Serve HTML unconditionally — the page JS prompts for the secret
    // and sends it as x-admin-secret header on all subsequent API calls.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML());
    return;
  }

  // SQLite backup endpoint — protected by BACKUP_SECRET (separate from ADMIN_SECRET)
  if (req.method === "GET" && url.pathname === "/admin/backup") {
    const backupSecret = process.env.BACKUP_SECRET;
    if (!backupSecret || req.headers["x-backup-secret"] !== backupSecret) {
      return json(res, 401, { error: "Unauthorized. Requires x-backup-secret header." });
    }
    try {
      const dbPath = process.env.DB_PATH || "/data/hederatoolbox.db";
      const dbFile = readFileSync(dbPath);
      const filename = `hederatoolbox-backup-${new Date().toISOString().slice(0,10)}.db`;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": dbFile.length,
      });
      res.end(dbFile);
    } catch (e) {
      return json(res, 500, { error: `Backup failed: ${e.message}` });
    }
    return;
  }

  return json(res, 404, { error: "Not found", mcp_endpoint: "/mcp" });
});

function getDashboardHTML() {
  const platformAccount = process.env.HEDERA_ACCOUNT_ID || "";
  const hasXAgent = !!process.env.XAGENT_API_KEY;
  // Note: secret is NOT embedded in HTML — dashboard uses prompt set at login
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HederaToolbox Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  header { background: #111; border-bottom: 1px solid #222; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 17px; font-weight: 600; color: #fff; }
  .badge { background: #1a3a2a; color: #4ade80; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #2a5a3a; }
  .badge.amber { background: #2a2000; color: #fbbf24; border-color: #4a3a00; }
  .btn { background: #1a1a1a; border: 1px solid #333; color: #888; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn:hover { color: #fff; border-color: #555; }
  .btn.danger { border-color: #4a1a1a; color: #f87171; }
  .btn.danger:hover { background: #2a0a0a; border-color: #ef4444; }
  .btn.green { border-color: #1a4a2a; color: #4ade80; }
  .btn.green:hover { background: #0a2a1a; }
  #last-updated { font-size: 11px; color: #444; margin-left: auto; }
  /* Layout */
  .p { padding: 20px 24px; }
  .grid-5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media(max-width:900px){ .grid-5{ grid-template-columns: repeat(3,1fr); } .grid-3{ grid-template-columns:1fr 1fr; } .grid-2{ grid-template-columns:1fr; } }
  @media(max-width:600px){ .grid-5{ grid-template-columns: 1fr 1fr; } }
  /* Cards */
  .card { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 16px; }
  .card-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 6px; }
  .card-value { font-size: 26px; font-weight: 700; color: #fff; line-height: 1; }
  .card-sub { font-size: 11px; color: #444; margin-top: 5px; }
  .card-sub.up { color: #4ade80; } .card-sub.down { color: #f87171; }
  /* Section headers */
  .sec-head { font-size: 11px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; display:flex; align-items:center; gap:8px; }
  /* Tables */
  .tbl { width: 100%; border-collapse: collapse; background: #111; border: 1px solid #1e1e1e; border-radius: 10px; overflow: hidden; }
  .tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; padding: 9px 12px; border-bottom: 1px solid #1a1a1a; }
  .tbl td { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid #161616; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl tbody { max-height: 220px; }
  .tbl-scroll { max-height: 220px; overflow-y: auto; border: 1px solid #1e1e1e; border-radius: 10px; }
  .tbl-scroll table { border: none; border-radius: 0; }
  /* Bar */
  .bar-wrap { background: #1a1a1a; border-radius: 3px; height: 4px; width: 80px; }
  .bar { background: #4ade80; height: 4px; border-radius: 3px; }
  /* Chart */
  .chart-wrap { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 16px; }
  .chart-bars { display: flex; align-items: flex-end; gap: 3px; height: 80px; }
  .chart-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .chart-bar-col .b { background: #1e3a2a; border-radius: 2px 2px 0 0; width: 100%; transition: background 0.2s; cursor: default; }
  .chart-bar-col .b:hover { background: #4ade80; }
  .chart-bar-col .lbl { font-size: 8px; color: #333; }
  /* Watcher dot */
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 5px #4ade80; display:inline-block; }
  .dot.amber { background: #fbbf24; box-shadow: 0 0 5px #fbbf24; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .dot { animation: pulse 2s infinite; }
  /* Mono */
  .mono { font-family: monospace; font-size: 11px; }
  /* Trend badge */
  .trend { font-size: 10px; padding: 1px 5px; border-radius: 4px; }
  .trend.up { background: #0a2a1a; color: #4ade80; }
  .trend.dn { background: #2a0a0a; color: #f87171; }
  .trend.flat { background: #1a1a1a; color: #666; }
  /* Modal */
  .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100; align-items:center; justify-content:center; }
  .modal-bg.open { display:flex; }
  .modal { background:#161616; border:1px solid #2a2a2a; border-radius:12px; padding:24px; width:360px; max-width:90vw; }
  .modal h3 { font-size:14px; font-weight:600; margin-bottom:14px; }
  .modal input { width:100%; background:#0a0a0a; border:1px solid #2a2a2a; color:#e0e0e0; padding:8px 10px; border-radius:6px; font-size:13px; margin-bottom:10px; }
  .modal input:focus { outline:none; border-color:#4ade80; }
  .modal-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:4px; }
  /* QR inline */
  .qr-inline { display:flex; align-items:center; gap:12px; }
  .qr-inline img { border-radius:6px; background:#fff; padding:4px; flex-shrink:0; }
  /* Spacer */
  .gap { height: 20px; }
  /* Section */
  .section { padding: 0 24px 20px; }
</style>
</head>
<body>
<header>
  <h1>HederaToolbox</h1>
  <span class="badge" id="network-badge">mainnet</span>
  <span class="dot" id="watcher-dot" style="margin-left:4px"></span>
  <span id="last-updated"></span>
  <button class="btn" onclick="loadAll()">Refresh</button>
</header>

<!-- KPI row -->
<div class="p">
  <div class="grid-5" id="kpi-grid">
    <div class="card"><div class="card-label">Total Calls</div><div class="card-value" id="kpi-calls">—</div></div>
    <div class="card"><div class="card-label">Accounts</div><div class="card-value" id="kpi-accounts">—</div><div class="card-sub" id="kpi-avg-calls"></div></div>
    <div class="card"><div class="card-label">Total Deposited</div><div class="card-value" id="kpi-deposited">—</div><div class="card-sub">ℏ received</div></div>
    <div class="card"><div class="card-label">This Month</div><div class="card-value" id="kpi-month-hbar">—</div><div class="card-sub" id="kpi-month-delta"></div></div>
    <div class="card"><div class="card-label">Rate Limit Hits</div><div class="card-value" id="kpi-ratelimit">—</div><div class="card-sub">last 24h</div></div>
  </div>
</div>

<!-- Revenue chart + Tool trends -->
<div class="section">
  <div class="grid-2">
    <div>
      <div class="sec-head">Revenue — last 30 days</div>
      <div class="chart-wrap">
        <div class="chart-bars" id="revenue-chart"></div>
      </div>
    </div>
    <div>
      <div class="sec-head">Tool Trends — 7d vs prev 7d</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Tool</th><th>This 7d</th><th>Prev 7d</th><th></th></tr></thead>
          <tbody id="tool-trends"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- Tool ranking + Top spenders -->
<div class="section">
  <div class="grid-2">
    <div>
      <div class="sec-head">Tool Ranking — all time</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>#</th><th>Tool</th><th>Calls</th><th>Revenue</th><th></th></tr></thead>
          <tbody id="tool-ranking"><tr><td colspan="5" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="sec-head">Top Spenders</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Account</th><th>Calls</th><th>HBAR</th></tr></thead>
          <tbody id="top-spenders"><tr><td colspan="3" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- Accounts + Recent transactions -->
<div class="section">
  <div class="grid-2">
    <div>
      <div class="sec-head">Accounts</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Account</th><th>Balance</th><th>Last Used</th><th></th></tr></thead>
          <tbody id="accounts-table"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="sec-head">Recent Transactions</div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Account</th><th>Tool</th><th>HBAR</th></tr></thead>
          <tbody id="recent-txs"><tr><td colspan="4" style="color:#333">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

${hasXAgent ? `<!-- X Agent status -->
<div class="section">
  <div class="sec-head">X Agent</div>
  <div class="grid-3">
    <div class="card"><div class="card-label">Balance</div><div class="card-value" id="xa-balance">—</div><div class="card-sub">xagent-internal</div></div>
    <div class="card"><div class="card-label">Calls (24h)</div><div class="card-value" id="xa-calls">—</div><div class="card-sub" id="xa-spent"></div></div>
    <div class="card"><div class="card-label">Last Active</div><div class="card-value" style="font-size:16px" id="xa-last">—</div></div>
  </div>
</div>` : ''}

<!-- Operational controls -->
<div class="section">
  <div class="sec-head">Controls</div>
  <div class="grid-3">
    <div class="card">
      <div class="card-label" style="margin-bottom:10px">Provision / Top Up Account</div>
      <input id="ctrl-key" placeholder="API key (e.g. 0.0.12345)" style="width:100%;background:#0a0a0a;border:1px solid #2a2a2a;color:#e0e0e0;padding:7px 9px;border-radius:6px;font-size:12px;margin-bottom:8px">
      <input id="ctrl-hbar" placeholder="HBAR amount" type="number" style="width:100%;background:#0a0a0a;border:1px solid #2a2a2a;color:#e0e0e0;padding:7px 9px;border-radius:6px;font-size:12px;margin-bottom:10px">
      <button class="btn green" style="width:100%" onclick="doProvision()">Provision / Top Up</button>
      <div id="ctrl-result" style="font-size:11px;color:#4ade80;margin-top:8px;min-height:16px"></div>
    </div>
    <div class="card">
      <div class="card-label" style="margin-bottom:10px">Platform Wallet</div>
      <div class="qr-inline">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=64x64&data=${platformAccount}" width="64" height="64" alt="QR">
        <div>
          <div class="mono" style="color:#4ade80;font-size:12px">${platformAccount}</div>
          <div style="font-size:11px;color:#444;margin-top:4px">Send HBAR to top up</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-label" style="margin-bottom:10px">GDPR Delete Account</div>
      <input id="del-key" placeholder="API key to delete" style="width:100%;background:#0a0a0a;border:1px solid #2a2a2a;color:#e0e0e0;padding:7px 9px;border-radius:6px;font-size:12px;margin-bottom:8px">
      <button class="btn danger" style="width:100%" onclick="openDeleteModal()">Delete Account…</button>
      <div style="font-size:10px;color:#444;margin-top:8px">Removes all rows from accounts, transactions, deposits &amp; consent_events.</div>
    </div>
  </div>
</div>

<div style="height:40px"></div>

<!-- Delete confirmation modal -->
<div class="modal-bg" id="delete-modal">
  <div class="modal">
    <h3>⚠️ Confirm Account Deletion</h3>
    <p style="font-size:12px;color:#888;margin-bottom:14px">This will permanently remove all data for <span id="del-modal-key" style="color:#f87171;font-family:monospace"></span>. Type the account ID to confirm.</p>
    <input id="del-confirm-input" placeholder="Type account ID to confirm">
    <div class="modal-actions">
      <button class="btn" onclick="closeDeleteModal()">Cancel</button>
      <button class="btn danger" onclick="doDelete()">Delete Permanently</button>
    </div>
    <div id="del-result" style="font-size:11px;color:#f87171;margin-top:10px;min-height:16px"></div>
  </div>
</div>

<script>
const SECRET = sessionStorage.getItem('hederatoolbox_admin_secret') || '';
if (!SECRET) {
  const input = prompt('Admin secret:');
  if (input) sessionStorage.setItem('hederatoolbox_admin_secret', input);
  location.reload();
}

async function fetchJSON(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json', ...(opts.headers||{}) } });
  if (r.status === 401) { sessionStorage.removeItem('hederatoolbox_admin_secret'); alert('Invalid secret.'); throw new Error('Unauthorized'); }
  return r.json();
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d/60) + 'm ago';
  if (d < 86400) return Math.round(d/3600) + 'h ago';
  return Math.round(d/86400) + 'd ago';
}

function pct(a, b) {
  if (!b) return a > 0 ? '+∞' : '—';
  const p = ((a - b) / b * 100).toFixed(0);
  return (p > 0 ? '+' : '') + p + '%';
}

async function loadAll() {
  try {
    const [stats, accounts, txs, analytics] = await Promise.all([
      fetchJSON('/admin/stats'),
      fetchJSON('/admin/accounts'),
      fetchJSON('/admin/transactions'),
      fetchJSON('/admin/analytics'),
    ]);

    // KPIs
    document.getElementById('kpi-calls').textContent = stats.summary.total_calls.toLocaleString();
    document.getElementById('kpi-accounts').textContent = stats.summary.total_accounts.toLocaleString();
    document.getElementById('kpi-avg-calls').textContent = analytics.avg_calls_per_account + ' avg calls/acct';
    document.getElementById('kpi-deposited').textContent = stats.summary.total_deposited_hbar + ' ℏ';
    document.getElementById('kpi-month-hbar').textContent = analytics.monthly.this_month.hbar + ' ℏ';
    document.getElementById('kpi-ratelimit').textContent = analytics.rate_limit_hits_24h;

    const mDelta = pct(parseFloat(analytics.monthly.this_month.hbar), parseFloat(analytics.monthly.last_month.hbar));
    const mEl = document.getElementById('kpi-month-delta');
    mEl.textContent = mDelta + ' vs last month';
    mEl.className = 'card-sub ' + (mDelta.startsWith('+') ? 'up' : mDelta.startsWith('-') ? 'down' : '');

    // Watcher dot
    document.getElementById('watcher-dot').className = 'dot';
    document.getElementById('network-badge').textContent = stats.watcher.network;

    // Revenue chart
    const rev = analytics.daily_revenue;
    const maxRev = Math.max(...rev.map(d => parseFloat(d.hbar)), 0.0001);
    document.getElementById('revenue-chart').innerHTML = rev.length === 0
      ? '<div style="color:#333;font-size:12px;align-self:center">No data yet</div>'
      : rev.map(d => {
          const h = Math.max(4, Math.round((parseFloat(d.hbar) / maxRev) * 76));
          const lbl = d.date.slice(5); // MM-DD
          return \`<div class="chart-bar-col" title="\${d.date}: \${d.hbar} ℏ (\${d.calls} calls)">
            <div class="b" style="height:\${h}px"></div>
            <div class="lbl">\${lbl.replace('-','/')}</div>
          </div>\`;
        }).join('');

    // Tool trends
    document.getElementById('tool-trends').innerHTML = analytics.tool_trends.length === 0
      ? '<tr><td colspan="4" style="color:#333">No data yet</td></tr>'
      : analytics.tool_trends.map(t => {
          const delta = t.calls_7d - t.calls_prev_7d;
          const cls = delta > 0 ? 'up' : delta < 0 ? 'dn' : 'flat';
          const sign = delta > 0 ? '+' : '';
          return \`<tr>
            <td>\${t.tool_name}</td>
            <td>\${t.calls_7d}</td>
            <td style="color:#444">\${t.calls_prev_7d}</td>
            <td><span class="trend \${cls}">\${sign}\${delta}</span></td>
          </tr>\`;
        }).join('');

    // Tool ranking
    const maxCalls = stats.tool_ranking[0]?.calls || 1;
    document.getElementById('tool-ranking').innerHTML = stats.tool_ranking.length === 0
      ? '<tr><td colspan="5" style="color:#333">No calls yet</td></tr>'
      : stats.tool_ranking.map((t, i) => \`<tr>
          <td style="color:#444">#\${i+1}</td>
          <td>\${t.tool}</td>
          <td>\${t.calls}</td>
          <td style="color:#4ade80">\${t.revenue_hbar} ℏ</td>
          <td><div class="bar-wrap"><div class="bar" style="width:\${Math.round((t.calls/maxCalls)*100)}%"></div></div></td>
        </tr>\`).join('');

    // Top spenders
    document.getElementById('top-spenders').innerHTML = analytics.top_spenders.length === 0
      ? '<tr><td colspan="3" style="color:#333">No data yet</td></tr>'
      : analytics.top_spenders.map(s => \`<tr>
          <td class="mono" style="color:#888">\${s.api_key}</td>
          <td>\${s.calls}</td>
          <td style="color:#4ade80">\${s.hbar} ℏ</td>
        </tr>\`).join('');

    // Accounts with delete button
    document.getElementById('accounts-table').innerHTML = accounts.accounts.length === 0
      ? '<tr><td colspan="4" style="color:#333">No accounts yet</td></tr>'
      : accounts.accounts.map(a => \`<tr>
          <td class="mono">\${a.api_key}</td>
          <td style="color:\${parseFloat(a.balance_hbar) > 0 ? '#4ade80' : '#f87171'}">\${a.balance_hbar} ℏ</td>
          <td style="color:#444">\${timeAgo(a.last_used)}</td>
          <td><button class="btn danger" style="padding:2px 7px;font-size:10px" onclick="setDeleteKey('\${a.api_key}')">Del</button></td>
        </tr>\`).join('');

    // Recent transactions (last 15)
    document.getElementById('recent-txs').innerHTML = txs.transactions.length === 0
      ? '<tr><td colspan="4" style="color:#333">No transactions yet</td></tr>'
      : txs.transactions.slice(0, 15).map(t => \`<tr>
          <td style="color:#444">\${timeAgo(t.timestamp)}</td>
          <td class="mono" style="color:#666">\${t.api_key}</td>
          <td>\${t.tool_name}</td>
          <td style="color:#4ade80">\${(t.amount_tinybars/100000000).toFixed(4)}</td>
        </tr>\`).join('');

    // X agent (if present)
    if (analytics.xagent) {
      const xa = analytics.xagent;
      document.getElementById('xa-balance').textContent = xa.balance_hbar + ' ℏ';
      document.getElementById('xa-calls').textContent = xa.calls_24h;
      document.getElementById('xa-spent').textContent = xa.spent_24h_hbar + ' ℏ spent';
      document.getElementById('xa-last').textContent = timeAgo(xa.last_used);
    }

    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) { console.error('Dashboard error:', e); }
}

// Provision / top-up
async function doProvision() {
  const key = document.getElementById('ctrl-key').value.trim();
  const hbar = parseFloat(document.getElementById('ctrl-hbar').value);
  const el = document.getElementById('ctrl-result');
  if (!key || !hbar) { el.style.color='#f87171'; el.textContent = 'Enter key and amount.'; return; }
  el.style.color='#888'; el.textContent = 'Provisioning...';
  try {
    const r = await fetchJSON('/admin/provision', { method: 'POST', body: JSON.stringify({ api_key: key, hbar }) });
    el.style.color='#4ade80';
    el.textContent = r.success ? \`Done — \${r.balance_hbar} ℏ balance\` : (r.error || 'Error');
    if (r.success) loadAll();
  } catch(e) { el.style.color='#f87171'; el.textContent = e.message; }
}

// Delete modal
function setDeleteKey(key) { document.getElementById('del-key').value = key; openDeleteModal(); }
function openDeleteModal() {
  const key = document.getElementById('del-key').value.trim();
  if (!key) return;
  document.getElementById('del-modal-key').textContent = key;
  document.getElementById('del-confirm-input').value = '';
  document.getElementById('del-result').textContent = '';
  document.getElementById('delete-modal').classList.add('open');
}
function closeDeleteModal() { document.getElementById('delete-modal').classList.remove('open'); }
async function doDelete() {
  const key = document.getElementById('del-key').value.trim();
  const confirm = document.getElementById('del-confirm-input').value.trim();
  const el = document.getElementById('del-result');
  if (confirm !== key) { el.textContent = 'Account ID does not match.'; return; }
  el.style.color='#888'; el.textContent = 'Deleting...';
  try {
    const r = await fetchJSON('/admin/delete-account', { method: 'DELETE', body: JSON.stringify({ api_key: key }) });
    if (r.success) {
      closeDeleteModal();
      document.getElementById('del-key').value = '';
      loadAll();
    } else { el.style.color='#f87171'; el.textContent = r.error || 'Failed'; }
  } catch(e) { el.style.color='#f87171'; el.textContent = e.message; }
}

loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`;
}

httpServer.listen(port, () => {
  console.error("HederaToolbox remote brain running on port " + port);
  console.error("Health: http://localhost:" + port + "/");
  console.error("MCP:    http://localhost:" + port + "/mcp");
  if (process.env.ADMIN_SECRET) {
    console.error("Admin:  http://localhost:" + port + "/admin/* (secret set)");
  }
});

startWatcher();
registerWebhook();

// Run PII purge immediately on startup, then daily via digest scheduler
purgeOldConsentPII();

// ── Automatic daily digest at 08:00 UTC ───────────────────────────────────
// Sends a morning summary to the owner so you wake up knowing how the
// platform performed overnight without having to check anything manually.
import { notifyOwner } from "./telegram.js";
import { scheduleXAgent } from "./xagent.js";

function scheduleDailyDigest() {
  const now = new Date();
  const next8am = new Date();
  next8am.setUTCHours(8, 0, 0, 0);
  if (next8am <= now) next8am.setUTCDate(next8am.getUTCDate() + 1);
  const msUntil = next8am - now;
  console.error(`[Digest] First digest in ${Math.round(msUntil / 3600000)}h (08:00 UTC daily)`);

  async function sendDigest() {
    try {
      const allTxs = getRecentTransactions(1000);
      const since  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
      const recent = allTxs.filter(t => t.timestamp >= since);
      const earned = recent.reduce((s, t) => s + t.amount_tinybars, 0) / 100_000_000;
      const activeAccounts = new Set(recent.map(t => t.api_key)).size;
      const toolCounts = {};
      for (const t of recent) toolCounts[t.tool_name] = (toolCounts[t.tool_name] || 0) + 1;
      const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `  ${name}: ${count}`)
        .join("\n") || "  none";
      const allAccounts = getAllAccounts();
      const totalHeld = allAccounts.reduce((s, a) => s + a.balance_tinybars, 0) / 100_000_000;

      await notifyOwner(
        `🌅 <b>Morning digest</b>\n\n` +
        `<b>Last 24h</b>\n` +
        `Tool calls: <b>${recent.length}</b>\n` +
        `HBAR earned: <b>${earned.toFixed(4)} ℏ</b>\n` +
        `Active accounts: <b>${activeAccounts}</b>\n\n` +
        `<b>Top tools:</b>\n${topTools}\n\n` +
        `<b>Platform total</b>\n` +
        `Accounts: <b>${allAccounts.length}</b>\n` +
        `HBAR held: <b>${totalHeld.toFixed(4)} ℏ</b>`
      );
      // Purge old PII daily alongside digest
      purgeOldConsentPII();
      console.error("[Digest] Daily digest sent");
    } catch (e) {
      console.error(`[Digest] Failed: ${e.message}`);
    }
  }

  setTimeout(() => {
    sendDigest();
    setInterval(sendDigest, 24 * 60 * 60 * 1000);
  }, msUntil);
}

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_ID) {
  scheduleDailyDigest();
  scheduleXAgent();
} else {
  console.error("[Digest] Telegram not configured — daily digest disabled");
}
console.error("Hedera network: " + process.env.HEDERA_NETWORK);
console.error("Tools: " + ALL_TOOLS.map((t) => t.name).join(", "));

// ── Nightly backup to GitHub ──────────────────────────────────────────────────
// Runs inside the main process — direct access to the DB file, no HTTP needed.
if (process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO) {
  import("https").then(({ default: https }) => {
    async function runBackup() {
      const dbPath = process.env.DB_PATH || "/data/hederatoolbox.db";
      const today = new Date().toISOString().slice(0, 10);
      const filename = `backups/hederatoolbox-${today}.db`;
      const repo = process.env.GITHUB_BACKUP_REPO;
      const token = process.env.GITHUB_BACKUP_TOKEN;

      console.error(`[Backup] Starting nightly backup to ${repo}/${filename}`);

      try {
        const dbFile = readFileSync(dbPath);
        console.error(`[Backup] Read ${(dbFile.length / 1024).toFixed(1)} KB`);

        const sha = await new Promise(resolve => {
          const req = https.request({
            hostname: "api.github.com",
            path: `/repos/${repo}/contents/${filename}`,
            headers: { "Authorization": `Bearer ${token}`, "User-Agent": "hederaintel-backup", "Accept": "application/vnd.github+json" },
          }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(data).sha) : resolve(null));
          });
          req.on("error", () => resolve(null));
          req.end();
        });

        const body = JSON.stringify({
          message: `chore: nightly backup ${today}`,
          content: dbFile.toString("base64"),
          ...(sha ? { sha } : {}),
        });

        await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "api.github.com",
            path: `/repos/${repo}/contents/${filename}`,
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${token}`,
              "User-Agent": "hederaintel-backup",
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
              if (res.statusCode === 200 || res.statusCode === 201) {
                console.error(`[Backup] ✅ Committed to GitHub`);
                resolve();
              } else {
                console.error(`[Backup] ❌ GitHub returned ${res.statusCode}: ${data}`);
                reject(new Error(`GitHub ${res.statusCode}`));
              }
            });
          });
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      } catch (e) {
        console.error(`[Backup] ❌ Failed: ${e.message}`);
      }
    }

    function scheduleBackup() {
      const now = new Date();
      const next2am = new Date();
      next2am.setUTCHours(2, 0, 0, 0);
      if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1);
      const msUntil2am = next2am - now;
      console.error(`[Backup] Next backup scheduled in ${Math.round(msUntil2am / 3600000)}h`);
      setTimeout(() => {
        runBackup();
        setInterval(runBackup, 24 * 60 * 60 * 1000);
      }, msUntil2am);
    }

    scheduleBackup();
  });
} else {
  console.error("[Backup] GITHUB_BACKUP_TOKEN or GITHUB_BACKUP_REPO not set — nightly backup disabled");
}
