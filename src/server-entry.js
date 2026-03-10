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
import { handleTelegramUpdate, registerWebhook } from "./telegram.js";
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
const FREE_RATE_LIMIT = 30;        // max calls per window
const FREE_RATE_WINDOW_MS = 60_000; // 60 seconds
const rateLimitStore = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || (now - entry.windowStart) > FREE_RATE_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  if (entry.count > FREE_RATE_LIMIT) return true;
  return false;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

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
    if (isRateLimited(ip)) {
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

  if (req.method === "GET" && url.pathname === "/admin/dashboard") {
    // Serve HTML unconditionally — the page JS prompts for the secret
    // and sends it as x-admin-secret header on all subsequent API calls.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML());
    return;
  }

  // SQLite backup endpoint — downloads the raw database file
  if (req.method === "GET" && url.pathname === "/admin/backup") {
    if (!isAdmin(req)) return json(res, 401, { error: "Unauthorized" });
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
  <h1>HederaToolbox</h1>
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
// Secret is read from sessionStorage (set once at login, never in HTML source)
const SECRET = sessionStorage.getItem('hederatoolbox_admin_secret') || '';

if (!SECRET) {
  const input = prompt('Admin secret:');
  if (input) sessionStorage.setItem('hederatoolbox_admin_secret', input);
  location.reload();
}

async function fetchJSON(path) {
  const r = await fetch(path, { headers: { 'x-admin-secret': SECRET } });
  if (r.status === 401) {
    sessionStorage.removeItem('hederatoolbox_admin_secret');
    alert('Invalid secret. Please refresh and try again.');
    throw new Error('Unauthorized');
  }
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

    document.getElementById('total-calls').textContent = stats.summary.total_calls.toLocaleString();
    document.getElementById('total-accounts').textContent = stats.summary.total_accounts.toLocaleString();
    document.getElementById('total-deposited').textContent = stats.summary.total_deposited_hbar + ' ℏ';
    document.getElementById('watcher-status').textContent = stats.watcher.status;
    document.getElementById('watcher-account').textContent = stats.watcher.platform_account + ' · ' + stats.watcher.network;
    document.getElementById('network-badge').textContent = stats.watcher.network;

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

    document.getElementById('recent-txs').innerHTML = txs.transactions.length === 0
      ? '<tr><td colspan="4" style="color:#444">No transactions yet</td></tr>'
      : txs.transactions.slice(0, 20).map(t => \`
        <tr>
          <td style="color:#555">\${timeAgo(t.timestamp)}</td>
          <td style="font-family:monospace;font-size:11px;color:#888">\${t.api_key}</td>
          <td>\${t.tool_name}</td>
          <td style="color:#4ade80">\${(t.amount_tinybars/100000000).toFixed(4)}</td>
        </tr>\`).join('');

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
  console.error("HederaToolbox remote brain running on port " + port);
  console.error("Health: http://localhost:" + port + "/");
  console.error("MCP:    http://localhost:" + port + "/mcp");
  if (process.env.ADMIN_SECRET) {
    console.error("Admin:  http://localhost:" + port + "/admin/* (secret set)");
  }
});

startWatcher();
registerWebhook();

// ── Automatic daily digest at 08:00 UTC ───────────────────────────────────
// Sends a morning summary to the owner so you wake up knowing how the
// platform performed overnight without having to check anything manually.
import { notifyOwner } from "./telegram.js";

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
