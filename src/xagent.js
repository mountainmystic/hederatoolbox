// xagent.js — HederaToolbox X (Twitter) posting agent
// Manual copy-paste version: generates tweet drafts, sends to Telegram for review.
// No X API required. You copy the approved text and post it yourself.

import https from "https";
import { notifyOwner, sendMessage } from "./telegram.js";

const OWNER_ID   = process.env.TELEGRAM_OWNER_ID;
const XAGENT_KEY = process.env.XAGENT_API_KEY;   // internal account e.g. "xagent-internal"

// ─── Pending drafts ───────────────────────────────────────────────────────────
// Keyed by numeric ID. Cleared when skip fires or 2h expires.
const pendingDrafts = new Map();
let draftCounter = 0;

// ─── Anthropic Haiku synthesis ────────────────────────────────────────────────

async function synthesiseTweet(toolData) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = `You are writing tweets for @HederaToolBox — an MCP server that gives AI agents pay-per-call access to live Hedera blockchain data.

EVERY tweet must do two things simultaneously:
1. Report a real on-chain data point from the tool output
2. Frame it as a demonstration of what HederaToolbox just did to get that data

Good examples:
- "HederaToolbox token_monitor just flagged 2.1M SAUCE moved across 3 accounts. That query cost $0.02. #Hedera #MCP"
- "47 AI agent tool calls on Hedera this week via HederaToolbox. Compliance checks, whale alerts, identity screening — all pay-per-call. #Hedera"
- "HederaToolbox hcs_understand scanned our compliance topic: normal activity, single writer, consistent cadence. Took 1 API call. #HCS #Hedera"

RULES:
- HARD LIMIT: 240 characters maximum. Count carefully. Cut ruthlessly.
- Must include at least one real number or data point from the tool output
- Always name the specific tool used (token_monitor, hcs_understand, etc.)
- Analyst voice: dry, direct, no hype, no exclamation marks
- Max 2 hashtags from: #Hedera #HBAR #HCS #HederaHashgraph #Web3 #AIAgents #MCP #OnChain
- No price predictions or investment language
- Anomaly alerts only: may use ⚠️ as a single flag
- Output ONLY the tweet text. No preamble, no quotes.`;

  const userPrompt = `Here is live Hedera on-chain data from our tool calls:\n\n${toolData}\n\nWrite a single tweet.`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text?.trim();
          if (!text) return reject(new Error("Empty response from Haiku"));
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Haiku response"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Single tool call via MCP endpoint ───────────────────────────────────────

async function callTool(toolName, toolArgs = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: { api_key: XAGENT_KEY, ...toolArgs },
    },
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.hederatoolbox.com",
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          console.error(`[XAgent] Raw response for ${toolName} (${data.length} bytes):`, data.slice(0, 300));
          // MCP SSE format: multiple "data: {...}" lines, last non-empty one has the result
          const lines = data.split("\n")
            .filter(l => l.startsWith("data:"))
            .map(l => l.replace(/^data:\s*/, "").trim())
            .filter(l => l && l !== "[DONE]");
          // Try each data line from last to first, find one with a result
          let content = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              const text = parsed?.result?.content?.[0]?.text
                || parsed?.params?.content?.[0]?.text
                || (parsed?.result ? JSON.stringify(parsed.result) : null);
              if (text) { content = text; break; }
            } catch { continue; }
          }
          // Fallback: try parsing entire response as JSON
          if (!content) {
            try {
              const parsed = JSON.parse(data);
              content = parsed?.result?.content?.[0]?.text || JSON.stringify(parsed?.result || parsed);
            } catch { content = null; }
          }
          if (content) {
            resolve({ tool: toolName, success: true, content });
          } else {
            console.error(`[XAgent] No content found in response for ${toolName}`);
            resolve({ tool: toolName, success: false, content: "no content in response" });
          }
        } catch (e) {
          console.error(`[XAgent] Parse error for ${toolName}:`, e.message);
          resolve({ tool: toolName, success: false, content: `parse error: ${e.message}` });
        }
      });
    });
    req.on("error", (e) => resolve({ tool: toolName, success: false, content: e.message }));
    req.write(body);
    req.end();
  });
}

// ─── Main data-gathering + synthesis cycle ────────────────────────────────────

export async function runXAgentCycle(label = "scheduled") {
  if (!XAGENT_KEY) {
    console.error("[XAgent] XAGENT_API_KEY not set — skipping run");
    return;
  }

  console.error(`[XAgent] Starting ${label} run`);

  // Call 3 tools in parallel — governance_monitor omitted (400s when no active proposals)
  // SAUCE (0.0.731861) is the most liquid mainnet token on SaucerSwap — reliable price data
  const results = await Promise.all([
    callTool("token_price",    { token_id: "0.0.731861" }),   // SAUCE token
    callTool("token_monitor",  { token_id: "0.0.731861" }),
    callTool("hcs_understand", { topic_id: "0.0.10353855" }), // platform compliance topic
  ]);

  const successCount = results.filter(r => r.success).length;
  if (successCount === 0) {
    console.error("[XAgent] All tool calls failed — skipping draft");
    await notifyOwner("⚠️ <b>XAgent</b>: All tool calls failed. No draft generated.");
    return;
  }

  // Inject platform stats so Haiku can reference real usage numbers
  let platformStats = "";
  try {
    const { getAllAccounts, getRecentTransactions } = await import("./db.js");
    const accounts = getAllAccounts();
    const txs = getRecentTransactions(1000);
    const since24h = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
    const since7d  = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19);
    const calls24h = txs.filter(t => t.timestamp >= since24h).length;
    const calls7d  = txs.filter(t => t.timestamp >= since7d).length;
    platformStats = `\n\n[HederaToolbox platform stats]\nTotal accounts: ${accounts.length}\nTool calls last 24h: ${calls24h}\nTool calls last 7 days: ${calls7d}\nTotal tool calls ever: ${txs.length}`;
  } catch { /* non-fatal */ }

  // Build tool data block for Haiku
  const toolData = results.map(r =>
    `[${r.tool}]\n${r.success ? r.content : "ERROR: " + r.content}`
  ).join("\n\n") + platformStats;

  // Synthesise tweet via Haiku
  let tweetText;
  try {
    tweetText = await synthesiseTweet(toolData);
  } catch (e) {
    console.error(`[XAgent] Haiku synthesis failed: ${e.message}`);
    await notifyOwner(`⚠️ <b>XAgent</b>: Tweet synthesis failed.\n${e.message}`);
    return;
  }

  // Check for anomaly signals in tool output
  const anomalySignals = [];
  for (const r of results) {
    if (!r.success) continue;
    const c = r.content.toLowerCase();
    if (r.tool === "token_monitor" && (c.includes("unusual") || c.includes("spike") || c.includes("whale"))) {
      anomalySignals.push("whale/volume anomaly");
    }
    if (r.tool === "hcs_understand" && (c.includes("anomaly") || c.includes("unusual") || c.includes("spike"))) {
      anomalySignals.push("HCS anomaly");
    }
  }

  await sendDraftToTelegram(tweetText, label, results, anomalySignals);
}

// ─── Send draft to Telegram ───────────────────────────────────────────────────

async function sendDraftToTelegram(tweetText, label, results, anomalySignals = []) {
  if (!OWNER_ID) {
    console.error("[XAgent] OWNER_ID not set — cannot send draft");
    return;
  }

  const draftId    = ++draftCounter;
  const charCount  = tweetText.length;
  const toolsUsed  = results.filter(r => r.success).map(r => r.tool).join(", ");
  const anomalyNote = anomalySignals.length > 0
    ? `\n⚠️ <b>Anomaly signals:</b> ${anomalySignals.join(", ")}`
    : "";
  const charNote = charCount > 240
    ? `⚠️ ${charCount} chars — edit before posting`
    : `${charCount} chars`;

  const msg =
    `🐦 <b>Draft tweet — ${label}</b>${anomalyNote}\n\n` +
    `<code>${tweetText}</code>\n\n` +
    `${charNote}\n` +
    `Tools: ${toolsUsed}\n\n` +
    `Copy text above to post. Tap <b>Skip</b> to discard, or reply <b>/edit &lt;new text&gt;</b> to revise.`;

  // Store pending draft with 2h auto-expiry
  pendingDrafts.set(draftId, { text: tweetText, label, createdAt: Date.now() });
  setTimeout(() => {
    if (pendingDrafts.has(draftId)) {
      pendingDrafts.delete(draftId);
      console.error(`[XAgent] Draft #${draftId} expired`);
    }
  }, 2 * 60 * 60 * 1000);

  await sendMessage(OWNER_ID, msg, {
    reply_markup: {
      inline_keyboard: [[
        { text: "⏭️ Skip", callback_data: `xagent_skip_${draftId}` },
      ]],
    },
  });

  console.error(`[XAgent] Draft #${draftId} sent to Telegram (${charCount} chars)`);
}

// ─── Handle Telegram inline button taps ──────────────────────────────────────
// Called from telegram.js when callback_query arrives

export async function handleXAgentCallback(callbackQuery) {
  const data   = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;

  await answerCallbackQuery(callbackQuery.id);

  if (data.startsWith("xagent_skip_")) {
    const draftId = parseInt(data.replace("xagent_skip_", ""), 10);
    if (pendingDrafts.has(draftId)) {
      pendingDrafts.delete(draftId);
      await sendMessage(chatId, `⏭️ Draft #${draftId} discarded.`);
      console.error(`[XAgent] Draft #${draftId} skipped by owner`);
    } else {
      await sendMessage(chatId, "Draft already expired or discarded.");
    }
  }
}

function answerCallbackQuery(id) {
  const body      = JSON.stringify({ callback_query_id: id });
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return Promise.resolve();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(body);
    req.end();
  });
}

// ─── Handle /edit command from owner ─────────────────────────────────────────
// Owner replies: /edit <revised tweet text>

export async function handleXAgentEdit(chatId, newText) {
  const charCount = newText.length;
  const charNote  = charCount > 240
    ? `⚠️ Still ${charCount} chars — trim before posting`
    : `${charCount} chars — good to go`;
  await sendMessage(chatId,
    `✏️ <b>Revised tweet:</b>\n\n<code>${newText}</code>\n\n${charNote}`
  );
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function scheduleXAgent() {
  if (!XAGENT_KEY) {
    console.error("[XAgent] XAGENT_API_KEY not set — scheduler disabled");
    return;
  }

  // 08:00 and 20:00 UTC daily
  for (const hour of [8, 20]) {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next - now;
    console.error(`[XAgent] ${hour}:00 UTC run in ${Math.round(ms / 3600000 * 10) / 10}h`);
    setTimeout(() => {
      runXAgentCycle(`${hour}:00 UTC`);
      setInterval(() => runXAgentCycle(`${hour}:00 UTC`), 24 * 60 * 60 * 1000);
    }, ms);
  }

  // Weekly digest — Mondays 09:00 UTC
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(9, 0, 0, 0);
  const daysUntilMonday = (1 - now.getUTCDay() + 7) % 7 || 7;
  next.setUTCDate(now.getUTCDate() + daysUntilMonday);
  const msMonday = next - now;
  console.error(`[XAgent] Weekly digest in ${Math.round(msMonday / 3600000)}h`);
  setTimeout(() => {
    runXAgentCycle("weekly digest");
    setInterval(() => runXAgentCycle("weekly digest"), 7 * 24 * 60 * 60 * 1000);
  }, msMonday);
}
