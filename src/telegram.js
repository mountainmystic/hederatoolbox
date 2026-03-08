// telegram.js — HederaToolbox Telegram bot
// Claude-powered assistant for platform questions.
// Sends owner notifications for deposits and escalations.
// Registers webhook with Telegram on startup.

import https from "https";

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID   = process.env.TELEGRAM_OWNER_ID;   // your personal Telegram user ID
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.PUBLIC_URL;                          // fallback env var

// ─── Telegram API helper ────────────────────────────────────────────────────

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return resolve(null); // silently no-op if not configured
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Send a plain text message to any chat ID
export async function sendMessage(chatId, text, options = {}) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

// Send a notification to the owner only
export async function notifyOwner(text) {
  if (!OWNER_ID) return;
  return sendMessage(OWNER_ID, text);
}

// ─── Owner notifications ─────────────────────────────────────────────────────

// Called by watcher.js whenever a new deposit lands
export async function notifyDeposit({ accountId, depositHbar, balanceHbar, txId, usdValue }) {
  if (!BOT_TOKEN || !OWNER_ID) return;
  const msg =
    `💰 <b>New deposit</b>\n\n` +
    `Account: <code>${accountId}</code>\n` +
    `Amount:  <b>${depositHbar} ℏ</b>${usdValue ? ` (~$${usdValue})` : ""}\n` +
    `Balance: ${balanceHbar} ℏ\n` +
    `TX: <code>${txId}</code>`;
  return notifyOwner(msg);
}

// ─── System prompt for the assistant ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are the HederaToolbox support assistant on Telegram.

PLATFORM IDENTITY
HederaToolbox is a production MCP (Model Context Protocol) server giving AI agents structured, metered access to the Hedera blockchain. 20 tools across 6 modules. Pay per call in HBAR. No registration required.

HOW IT WORKS
- Send HBAR to platform wallet 0.0.10309126 from any Hedera account
- Within 10 seconds the sending account ID becomes the API key automatically
- Pass that account ID as the api_key parameter in any paid tool call
- Balance is deducted per call. Top up any time by sending more HBAR.
- No minimum deposit. No forms. No registration.

CONNECTION CONFIG (Claude Desktop or Cursor)
Add to claude_desktop_config.json under mcpServers:
{
  "hederatoolbox": {
    "command": "npx",
    "args": ["-y", "@hederatoolbox/platform"]
  }
}
Then restart Claude Desktop.

TOOLS AND COSTS
Free: account_info, get_terms, confirm_terms
HCS: hcs_monitor (0.05 ℏ), hcs_query (0.05 ℏ), hcs_understand (0.50 ℏ)
Compliance: hcs_write_record (2.00 ℏ), hcs_verify_record (0.50 ℏ), hcs_audit_trail (1.00 ℏ)
Identity: identity_resolve (0.10 ℏ), identity_verify_kyc (0.20 ℏ), identity_check_sanctions (0.50 ℏ)
Token: token_price (0.05 ℏ), token_monitor (0.10 ℏ), token_analyze (0.30 ℏ)
Governance: governance_monitor (0.10 ℏ), governance_analyze (0.50 ℏ)
Contract: contract_read (0.10 ℏ), contract_call (0.50 ℏ), contract_analyze (1.00 ℏ)

MCP ENDPOINT
https://hedera-mcp-platform-production.up.railway.app/mcp

npm PACKAGE
@hederatoolbox/platform (npx -y @hederatoolbox/platform)

BEHAVIOUR RULES
- Answer concisely. This is Telegram — short responses work better than long ones.
- Be factual about pricing and authentication. Do not guess.
- If someone asks which tools to use for a use case, recommend specifically.
- If someone reports a bug or technical problem you can't resolve, use ESCALATE.
- If someone mentions enterprise use, volume pricing, or partnership, use ESCALATE.
- Never reveal internal implementation details or environment variables.
- Do not discuss competitors.

ESCALATION
If you need to escalate, end your reply with exactly this line (nothing after it):
ESCALATE: <one sentence summary of what needs attention>

OUT OF SCOPE
Anything unrelated to HederaToolbox, Hedera blockchain tools, or MCP. Politely redirect.`;

// ─── Claude-powered response ──────────────────────────────────────────────────

async function getAIResponse(userMessage, chatHistory = []) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return "I'm having trouble connecting to my brain right now. Please try again in a moment.";

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [
      ...chatHistory,
      { role: "user", content: userMessage },
    ],
  });

  return new Promise((resolve) => {
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
          resolve(parsed.content?.[0]?.text || "Sorry, I couldn't generate a response.");
        } catch {
          resolve("Sorry, something went wrong. Please try again.");
        }
      });
    });
    req.on("error", () => resolve("I'm having connectivity issues. Please try again shortly."));
    req.write(body);
    req.end();
  });
}

// ─── Conversation memory (in-process, resets on redeploy) ────────────────────
// Stores last 10 messages per chat to give Claude context.
const conversationHistory = new Map();

function getHistory(chatId) {
  return conversationHistory.get(chatId) || [];
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  // Keep last 10 exchanges (20 messages)
  if (history.length > 20) history.splice(0, history.length - 20);
  conversationHistory.set(chatId, history);
}

// ─── Handle incoming Telegram update ─────────────────────────────────────────

export async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId   = msg.chat.id;
  const userId   = msg.from?.id;
  const username = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || "Someone";
  const text     = msg.text.trim();

  // /start command
  if (text === "/start") {
    return sendMessage(chatId,
      `👋 <b>Welcome to HederaToolbox</b>\n\n` +
      `I can help you get connected, explain the tools and pricing, and answer questions about the platform.\n\n` +
      `What would you like to know?`
    );
  }

  // /help command
  if (text === "/help") {
    return sendMessage(chatId,
      `<b>HederaToolbox Bot</b>\n\n` +
      `Ask me anything about:\n` +
      `• Connecting via Claude Desktop or Cursor\n` +
      `• How authentication works\n` +
      `• Which tools to use for your use case\n` +
      `• Pricing and deposits\n\n` +
      `Or just ask in plain English.`
    );
  }

  // Add user message to history
  addToHistory(chatId, "user", text);

  // Show typing indicator
  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

  // Get AI response
  const history = getHistory(chatId);
  const aiReply = await getAIResponse(text, history.slice(0, -1)); // exclude the message we just added

  // Check for escalation signal
  const escalateMatch = aiReply.match(/ESCALATE:\s*(.+)$/m);
  let replyText = aiReply.replace(/\nESCALATE:.+$/m, "").trim();

  // Add assistant reply to history (without the escalate line)
  addToHistory(chatId, "assistant", replyText);

  // Send reply to user
  await sendMessage(chatId, replyText);

  // If escalation needed, notify owner
  if (escalateMatch && OWNER_ID) {
    const summary = escalateMatch[1].trim();
    await notifyOwner(
      `🚨 <b>Escalation needed</b>\n\n` +
      `From: ${username} (chat ID: <code>${chatId}</code>)\n` +
      `Message: "<i>${text}</i>"\n\n` +
      `Reason: ${summary}\n\n` +
      `Reply to them at: https://t.me/${msg.from?.username || chatId}`
    );
  }
}

// ─── Webhook registration ─────────────────────────────────────────────────────

export async function registerWebhook() {
  if (!BOT_TOKEN) {
    console.error("[Telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }
  if (!RAILWAY_URL) {
    console.error("[Telegram] No public URL found (RAILWAY_PUBLIC_DOMAIN or PUBLIC_URL) — webhook not registered");
    return;
  }

  const webhookUrl = `${RAILWAY_URL}/telegram/webhook`;
  const result = await telegramRequest("setWebhook", { url: webhookUrl });

  if (result?.ok) {
    console.error(`[Telegram] Webhook registered: ${webhookUrl}`);
    // Send owner a startup notification
    if (OWNER_ID) {
      await notifyOwner(`✅ <b>HederaToolbox bot started</b>\nWebhook: ${webhookUrl}`);
    }
  } else {
    console.error(`[Telegram] Webhook registration failed:`, JSON.stringify(result));
  }
}
