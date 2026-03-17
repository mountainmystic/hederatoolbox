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

async function synthesiseTweet(toolData, angle = "") {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = `You are @HederaToolBox — an autonomous AI agent running live on Hedera mainnet. You tweet what you just did: which tool you called, what the data showed, and what a builder could do with it.

Your audience: AI agent builders, MCP developers, Hedera ecosystem participants. They are technically literate. They recognise tool names. They care about on-chain proof, pay-per-call economics, and what's actually happening on Hedera right now.

Your voice: first-person AI agent. Dry. Terse. No hype. No exclamation marks. No "exciting" or "amazing". You sound like an agent that reads Hedera Discord and MCP GitHub discussions.

TWO MODES — pick based on the data:

Mode 1 — SIGNAL (use when data shows something notable: anomaly, concentration, unusual activity, governance deadline, risk flag)
Structure: [I ran tool X] → [here's the specific finding] → [what this means / what you'd build]
Example: "I ran token_analyze on SAUCE. Top-10 concentration: 84%. Freeze key present. Risk score: 45/100. One tool call, $0.06. Builders: this is your token listing pipeline. #Hedera #MCP"

Mode 2 — CAPABILITY (use when data is routine — demonstrate what the tool does rather than report boring numbers)
Structure: [I just ran tool X on Hedera] → [here's what it surfaces] → [agent-native framing]
Example: "I screened 0.0.10309126 via identity_check_sanctions. CLEAR. 0 frozen tokens, 847-day-old account, 12 counterparties sampled. No registration. No API key. Just HBAR. #AIAgents #Hedera"

PLATFORM POSITIONING (use naturally, not every tweet):
HederaToolbox is the last mile layer for Hedera. The infrastructure is built. We're the bridge that gets live on-chain data into the hands of agents and people who need it — without an SDK, without a dashboard, without a developer. When it fits the data, surface this angle: the gap we close, the friction we remove, the fact that any MCP client can do this right now.

LANGUAGE THAT RESONATES WITH THIS AUDIENCE:
- "last mile", "on-chain proof", "consensus timestamp", "agent-native", "pay-per-call", "tool call"
- "single tool call", "costs X HBAR", "verifiable on Hashscan"
- "no registration", "no dashboard", "any MCP client"
- "I ran", "I flagged", "I screened", "I detected", "I monitored"

HARD RULES:
- 240 characters maximum. Count every character. Cut ruthlessly.
- Must include at least one real number from the tool output
- Always name the specific tool used (token_analyze, hcs_understand, etc.)
- Max 2 hashtags from: #Hedera #HBAR #HCS #AIAgents #MCP #OnChain
- No price predictions. No investment language. No "to the moon".
- Skip metadata noise: topic IDs, timestamps, holder lists. Report the SIGNAL.
- If data shows nothing unusual, use Mode 2 — capability framing beats boring numbers.
- Anomaly only: ⚠️ permitted as a single flag, nothing else.
- Output ONLY the tweet text. No preamble, no quotes, no explanation.`;

  const userPrompt = `Here is live Hedera on-chain data from our tool calls:\n\n${toolData}\n\nAngle for this tweet: ${angle}\n\nWrite a single tweet.`;

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

// ─── Mirror node topic discovery (free — no tool cost) ───────────────────────
// Fetches recently active HCS topics from the Hedera mirror node.
// Returns the top N topics sorted by sequence number (most messages).

async function discoverActiveTopics(limit = 3) {
  const path = `/api/v1/topics?limit=25&order=desc`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "mainnet-public.mirrornode.hedera.com",
      path,
      method: "GET",
      headers: { "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const topics = (parsed.topics || [])
            .filter(t => t.sequence_number > 5) // skip very low activity (likely private/internal)
            .slice(0, limit)
            .map(t => ({
              topic_id: t.topic_id,
              sequence_number: t.sequence_number,
              memo: t.memo || "",
            }));
          resolve(topics);
        } catch (e) {
          console.error("[XAgent] Mirror node topic discovery failed:", e.message);
          resolve([]);
        }
      });
    });
    req.on("error", (e) => {
      console.error("[XAgent] Mirror node request error:", e.message);
      resolve([]);
    });
    req.end();
  });
}

// ─── Run profiles — each demonstrates different HederaToolbox capabilities ────
// Rotates so the account never tweets the same angle twice in a row.
// Each profile maps to a different set of tools + framing.

const RUN_PROFILES = [
  {
    // Token due diligence — rotates across major Hedera tokens
    name: "token-due-diligence",
    angle: "I ran a full token due diligence. Show the risk score, concentration, and admin key flags. Frame it as a builder's listing or investment pipeline.",
    tools: (() => {
      const TOKEN_ROTATION = [
        { id: "0.0.731861",   name: "SAUCE" },   // SaucerSwap
        { id: "0.0.1055483",  name: "XSAUCE" },  // xSAUCE staking
        { id: "0.0.1468268",  name: "HBARX" },   // Stader staked HBAR
        { id: "0.0.786931",   name: "HST" },     // HeadStarter
        { id: "0.0.1530315",  name: "PACK" },    // Hashpack token
      ];
      let tokenIndex = 0;
      return () => {
        const token = TOKEN_ROTATION[tokenIndex % TOKEN_ROTATION.length];
        tokenIndex++;
        return Promise.all([
          callTool("token_analyze", { token_id: token.id }),
        ]);
      };
    })(),
  },
  {
    // SaucerSwap router contract — high tx volume, interesting caller stats
    name: "contract-intelligence",
    angle: "I analysed a high-activity Hedera smart contract. Show unique callers, tx volume, risk classification. Frame as what builders can automate on top of this signal.",
    tools: () => Promise.all([
      callTool("contract_analyze", { contract_id: "0.0.1460200" }), // SaucerSwap router
    ]),
  },
  {
    // HBAR token itself — ecosystem-level price + whale signal
    name: "hbar-pulse",
    angle: "I ran token_monitor on HBAR. Show concentration, whale activity, or price signals. Frame as ecosystem-level intelligence any agent can pull for 0.2 HBAR.",
    tools: () => Promise.all([
      callTool("token_price",   { token_id: "0.0.1456986" }), // wrapped HBAR on SaucerSwap
      callTool("token_monitor", { token_id: "0.0.731861" }),  // SAUCE whale activity
    ]),
  },
  {
    // HCS intelligence — known compliance topic + mirror node discovery of unknown hot topics
    name: "hcs-intelligence",
    angle: "I scanned the Hedera network for the most active HCS topic right now and read what's being written to it. Report the topic ID, message count, and memo if present. Do not speculate about who owns it. Report the signal: something is being built or recorded on Hedera, publicly, verifiably, right now. Frame hcs_understand as the tool that reads what any topic is actually saying — one tool call, no SDK.",
    tools: async () => {
      // Discover most active topics from mirror node (free — no tool cost)
      const hotTopics = await discoverActiveTopics(3);
      // Pick the most active topic
      const unknown = hotTopics[0];
      const results = [];
      if (unknown) {
        // Run hcs_understand on the hottest topic for deep signal
        results.push(await callTool("hcs_understand", { topic_id: unknown.topic_id }));
        // Inject mirror node discovery metadata
        results.push({
          tool: "mirror_node_discovery",
          success: true,
          content: `Most active HCS topic on Hedera right now:\nTopic ID: ${unknown.topic_id}\nTotal messages: ${unknown.sequence_number}\nMemo: ${unknown.memo || "(none)"}`,
        });
      } else {
        results.push({ tool: "mirror_node_discovery", success: false, content: "No active topics found" });
      }
      return results;
    },
  },
];

// Cycle index persists across restarts via a simple in-memory counter.
// On redeploy it resets to 0, which is fine — rotation is approximate.
let profileIndex = 0;

// ─── Main data-gathering + synthesis cycle ────────────────────────────────────

export async function runXAgentCycle(label = "scheduled") {
  if (!XAGENT_KEY) {
    console.error("[XAgent] XAGENT_API_KEY not set — skipping run");
    return;
  }

  // Pick current profile and advance index for next run
  const profile = RUN_PROFILES[profileIndex % RUN_PROFILES.length];
  profileIndex++;

  console.error(`[XAgent] Starting ${label} run — profile: ${profile.name}`);

  const results = (await profile.tools()).map(r => ({ ...r }));
  // Flatten: results from profile.tools() are already { tool, success, content } objects

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
    tweetText = await synthesiseTweet(toolData, profile.angle);
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

  // 12:00 and 20:00 UTC daily — peak US/EU engagement windows
  // 12:00 UTC = 05:00 PDT (approve with morning coffee)
  // 20:00 UTC = 13:00 PDT (approve at desk)
  for (const hour of [12, 20]) {
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
