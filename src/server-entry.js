// server-entry.js — Railway / HTTP server entry point (remote brain)
// This is what Railway runs. Contains all Hedera SDK logic.
// NOT shipped in the npm package (blocked by .npmignore).
import "dotenv/config";
import { createServer, ALL_TOOLS } from "./server.js";
import { getCosts } from "./payments.js";
import { provisionKey, getAllAccounts, getRecentTransactions, getHITLEvent, approveHITLEvent } from "./db.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS = JSON.parse(readFileSync(path.join(__dirname, "../legal/terms.json"), "utf-8"));
const { version: VERSION } = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
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
  const url = new URL(req.url, `http://localhost`);
  return req.headers["x-admin-secret"] === secret
    || url.searchParams.get("secret") === secret;
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
      version: VERSION,
      network: process.env.HEDERA_NETWORK,
      account: process.env.HEDERA_ACCOUNT_ID,
      modules: ["hcs", "compliance", "governance", "token", "identity", "contract", "nft", "bridge"],
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

  // HITL approval endpoint — human clicks this URL to unblock a hard-stop
  if (req.method === "GET" && url.pathname.startsWith("/hitl/approve/")) {
    const token = url.pathname.split("/").pop();
    const event = getHITLEvent(token);
    if (!event) return json(res, 404, { error: "Approval token not found" });
    if (event.status === "approved") return json(res, 200, { message: "Already approved", event });
    approveHITLEvent(token);
    return json(res, 200, {
      message: "Approved. The pending tool call may now be retried by the agent.",
      approval_token: token,
      tool: event.tool_name,
      api_key: event.api_key,
      amount_hbar: event.amount_hbar,
      approved_at: new Date().toISOString(),
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

  if (req.method === "GET" && url.pathname === "/admin/dashboard") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML());
    return;
  }

  return json(res, 404, { error: "Not found", mcp_endpoint: "/mcp" });
});

function getDashboardHTML() {
  const platformAccount = process.env.HEDERA_ACCOUNT_ID || "";
  const adminSecret = process.env.ADMIN_SECRET || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HederaIntel Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  header { background: #111; border-bottom: 1px solid #222; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; color: #fff; }
  header .badge { background: #1a3a2a; color: #4ade80; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #2a5a3a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; padding: 24px; }
  .card { background: #111; border: 1px solid #222; border-radius: 10px; padding: 20px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 8px; }
  .card .value { font-size: 28px; font-weight: 700; color: #fff; }
  .card .sub { font-size: 12px; color: #555; margin-top: 4px; }
  .section { padding: 0 24px 24px; }
  .section h2 { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #111; border: 1px solid #222; border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #555; padding: 10px 14px; border-bottom: 1px solid #1a1a1a; }
  td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #1a1a1a; }
  tr:last-child td { border-bottom: none; }
  .bar-wrap { background: #1a1a1a; border-radius: 4px; height: 6px; width: 100%; margin-top: 4px; }
  .bar { background: #4ade80; height: 6px; border-radius: 4px; transition: width 0.4s; }
  .watcher { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .qr-wrap img { border-radius: 8px; background: #fff; padding: 8px; }
  .account-id { font-family: monospace; font-size: 13px; color: #4ade80; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 24px 24px; }
  @media(max-width:700px){ .two-col{ grid-template-columns:1fr; } }
  .refresh { margin-left: auto; background: #1a1a1a; border: 1px solid #333; color: #888; padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .refresh:hover { color: #fff; border-color: #555; }
  #last-updated { font-size: 11px; color: #444; margin-left: 8px; }
</style>
</head>
<body>
<header>
  <h1>HederaIntel</h1>
  <span class="badge" id="network-badge">mainnet</span>
  <span id="last-updated"></span>
  <button class="refresh" onclick="load()">Refresh</button>
</header>

<div class="grid" id="summary-cards">
  <div class="card"><h2>Total Calls</h2><div class="value" id="total-calls">—</div></div>
  <div class="card"><h2>Accounts</h2><div class="value" id="total-accounts">—</div></div>
  <div class="card"><h2>Total Deposited</h2><div class="value" id="total-deposited">—</div><div class="sub">HBAR received</div></div>
  <div class="card">
    <h2>Watcher</h2>
    <div class="watcher"><div class="dot" id="watcher-dot"></div><span id="watcher-status">checking...</span></div>
    <div class="sub" id="watcher-account"></div>
  </div>
</div>

<div class="two-col">
  <div>
    <div class="section">
      <h2>Tool Ranking</h2>
      <table>
        <thead><tr><th>#</th><th>Tool</th><th>Calls</th><th>Revenue</th><th style="width:100px"></th></tr></thead>
        <tbody id="tool-ranking"><tr><td colspan="5" style="color:#444">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="section">
      <h2>Recent Transactions</h2>
      <table>
        <thead><tr><th>Time</th><th>Account</th><th>Tool</th><th>HBAR</th></tr></thead>
        <tbody id="recent-txs"><tr><td colspan="4" style="color:#444">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="section">
      <h2>Top Up</h2>
      <div class="card qr-wrap">
        <div class="account-id" id="qr-account">${platformAccount}</div>
        <img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${platformAccount}" alt="QR" width="180" height="180">
        <div class="sub">Send HBAR to this address to top up any account</div>
      </div>
    </div>
    <div class="section" style="margin-top:0">
      <h2>Accounts</h2>
      <table>
        <thead><tr><th>Account</th><th>Balance</th><th>Last Used</th></tr></thead>
        <tbody id="accounts-table"><tr><td colspan="3" style="color:#444">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<script>
const SECRET = '${adminSecret}';

async function fetchJSON(path) {
  const r = await fetch(path + '?secret=' + SECRET);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return Math.round(diff) + 's ago';
  if (diff < 3600) return Math.round(diff/60) + 'm ago';
  if (diff < 86400) return Math.round(diff/3600) + 'h ago';
  return Math.round(diff/86400) + 'd ago';
}

async function load() {
  try {
    const [stats, accounts, txs] = await Promise.all([
      fetchJSON('/admin/stats'),
      fetchJSON('/admin/accounts'),
      fetchJSON('/admin/transactions'),
    ]);

    // Summary cards
    document.getElementById('total-calls').textContent = stats.summary.total_calls.toLocaleString();
    document.getElementById('total-accounts').textContent = stats.summary.total_accounts.toLocaleString();
    document.getElementById('total-deposited').textContent = stats.summary.total_deposited_hbar + ' ℏ';
    document.getElementById('watcher-status').textContent = stats.watcher.status;
    document.getElementById('watcher-account').textContent = stats.watcher.platform_account + ' · ' + stats.watcher.network;
    document.getElementById('network-badge').textContent = stats.watcher.network;

    // Tool ranking
    const maxCalls = stats.tool_ranking[0]?.calls || 1;
    document.getElementById('tool-ranking').innerHTML = stats.tool_ranking.length === 0
      ? '<tr><td colspan="5" style="color:#444">No calls yet</td></tr>'
      : stats.tool_ranking.map((t, i) => \`
        <tr>
          <td style="color:#555">#\${i+1}</td>
          <td>\${t.tool}</td>
          <td>\${t.calls}</td>
          <td style="color:#4ade80">\${t.revenue_hbar} ℏ</td>
          <td><div class="bar-wrap"><div class="bar" style="width:\${Math.round((t.calls/maxCalls)*100)}%"></div></div></td>
        </tr>\`).join('');

    // Recent transactions
    document.getElementById('recent-txs').innerHTML = txs.transactions.length === 0
      ? '<tr><td colspan="4" style="color:#444">No transactions yet</td></tr>'
      : txs.transactions.slice(0, 20).map(t => \`
        <tr>
          <td style="color:#555">\${timeAgo(t.timestamp)}</td>
          <td style="font-family:monospace;font-size:11px;color:#888">\${t.api_key}</td>
          <td>\${t.tool_name}</td>
          <td style="color:#4ade80">\${(t.amount_tinybars/100000000).toFixed(4)}</td>
        </tr>\`).join('');

    // Accounts
    document.getElementById('accounts-table').innerHTML = accounts.accounts.length === 0
      ? '<tr><td colspan="3" style="color:#444">No accounts yet</td></tr>'
      : accounts.accounts.map(a => \`
        <tr>
          <td style="font-family:monospace;font-size:11px">\${a.api_key}</td>
          <td style="color:\${parseFloat(a.balance_hbar) > 0 ? '#4ade80' : '#ef4444'}">\${a.balance_hbar} ℏ</td>
          <td style="color:#555">\${timeAgo(a.last_used)}</td>
        </tr>\`).join('');

    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    console.error('Dashboard error:', e);
  }
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

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
