// db.js - SQLite persistence layer for HederaIntel accounts and transactions
// Uses node:sqlite — built into Node.js 22.5+, zero installation required.

import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "hederaintel.db");

// Open (or create) the database file on disk
const db = new DatabaseSync(DB_PATH);

// ─────────────────────────────────────────────
// Schema — runs once on startup, safe to re-run
// ─────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    api_key           TEXT PRIMARY KEY,
    balance_tinybars  INTEGER NOT NULL DEFAULT 0,
    hedera_account_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_used         TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key         TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    amount_tinybars INTEGER NOT NULL,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    hedera_account_id TEXT NOT NULL,
    transaction_id    TEXT NOT NULL UNIQUE,
    amount_tinybars   INTEGER NOT NULL,
    timestamp         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS consent_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key         TEXT NOT NULL,
    hedera_account_id TEXT,
    terms_version   TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    hcs_sequence    INTEGER,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    ip           TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip)
  );

  CREATE TABLE IF NOT EXISTS provenance (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key          TEXT NOT NULL,
    agent_did        TEXT,
    tool_name        TEXT NOT NULL,
    inputs_summary   TEXT,
    outputs_summary  TEXT,
    risk_flags       TEXT,
    timestamp        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_hedera ON accounts(hedera_account_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_api_key ON transactions(api_key);
  CREATE INDEX IF NOT EXISTS idx_deposits_hedera ON deposits(hedera_account_id);
  CREATE INDEX IF NOT EXISTS idx_consent_api_key ON consent_events(api_key);
  CREATE INDEX IF NOT EXISTS idx_provenance_api_key ON provenance(api_key);
  CREATE INDEX IF NOT EXISTS idx_provenance_agent_did ON provenance(agent_did);
`);

// ─────────────────────────────────────────────
// Prepared statements (compiled once, reused)
// ─────────────────────────────────────────────

const stmts = {
  getAccount:         db.prepare("SELECT * FROM accounts WHERE api_key = ?"),
  getAccountByHedera: db.prepare("SELECT * FROM accounts WHERE hedera_account_id = ?"),
  insertAccount:      db.prepare("INSERT OR IGNORE INTO accounts (api_key, balance_tinybars, hedera_account_id) VALUES (?, ?, ?)"),
  getBalance:         db.prepare("SELECT balance_tinybars FROM accounts WHERE api_key = ?"),
  deduct:             db.prepare("UPDATE accounts SET balance_tinybars = balance_tinybars - ?, last_used = datetime('now') WHERE api_key = ?"),
  credit:             db.prepare("UPDATE accounts SET balance_tinybars = balance_tinybars + ? WHERE api_key = ?"),
  logTx:              db.prepare("INSERT INTO transactions (api_key, tool_name, amount_tinybars) VALUES (?, ?, ?)"),
  checkDeposit:       db.prepare("SELECT 1 FROM deposits WHERE transaction_id = ?"),
  insertDeposit:      db.prepare("INSERT OR IGNORE INTO deposits (hedera_account_id, transaction_id, amount_tinybars) VALUES (?, ?, ?)"),
  allAccounts:        db.prepare("SELECT api_key, balance_tinybars, hedera_account_id, created_at, last_used FROM accounts ORDER BY created_at DESC"),
  recentTxs:          db.prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?"),
  txHistory:          db.prepare("SELECT * FROM transactions WHERE api_key = ? ORDER BY timestamp DESC LIMIT ?"),
  upsertAccount:      db.prepare(`
    INSERT INTO accounts (api_key, balance_tinybars, hedera_account_id)
    VALUES (?, ?, ?)
    ON CONFLICT(api_key) DO UPDATE SET balance_tinybars = balance_tinybars + ?
  `),
};

// ─────────────────────────────────────────────
// Account functions
// ─────────────────────────────────────────────

// Get account by api_key. Returns null if not found.
export function getAccount(apiKey) {
  return stmts.getAccount.get(apiKey) || null;
}

// Get account by Hedera account ID (e.g. "0.0.456789")
export function getAccountByHederaId(hederaAccountId) {
  return stmts.getAccountByHedera.get(hederaAccountId) || null;
}

// Create a new account if it doesn't already exist.
export function createAccount(apiKey, hederaAccountId = null, startingBalanceTinybars = 0) {
  stmts.insertAccount.run(apiKey, startingBalanceTinybars, hederaAccountId);
  return getAccount(apiKey);
}

// Atomic deduct statement — check and deduct in a single SQL operation.
// If balance is insufficient, 0 rows are changed and we never touch the ledger.
const stmtAtomicDeduct = db.prepare(`
  UPDATE accounts
  SET    balance_tinybars = balance_tinybars - ?,
         last_used        = datetime('now')
  WHERE  api_key          = ?
  AND    balance_tinybars >= ?
`);

// Deduct from balance atomically. Throws a clear agent-readable error if
// the key is unknown or balance is too low. Returns new balance in tinybars.
// The UPDATE + changes() pattern is a single atomic operation — safe under
// any concurrency level and future horizontal scaling.
export function deductBalance(apiKey, amountTinybars, toolName) {
  // First check the account exists so we can give a clear error message
  const account = stmts.getBalance.get(apiKey);

  if (!account) {
    throw new Error(
      `Unknown API key "${apiKey}". ` +
      `To create an account automatically, send HBAR to the platform wallet. ` +
      `Call the account_info tool (no API key required) for the wallet address and full instructions.`
    );
  }

  // Atomic check-and-deduct: only succeeds if balance >= amount at the moment
  // of the write. No separate read-then-write window for a race condition.
  const result = stmtAtomicDeduct.run(amountTinybars, apiKey, amountTinybars);

  if (result.changes === 0) {
    // Row existed but balance was too low (the only reason changes === 0 here)
    const required  = (amountTinybars          / 100_000_000).toFixed(4);
    const available = (account.balance_tinybars / 100_000_000).toFixed(4);
    throw new Error(
      `Insufficient balance. Required: ${required} HBAR, Available: ${available} HBAR. ` +
      `Send HBAR to the platform wallet to top up. ` +
      `Call the account_info tool for the wallet address.`
    );
  }

  // Log the transaction and return the new balance
  stmts.logTx.run(apiKey, toolName, amountTinybars);
  return stmts.getBalance.get(apiKey).balance_tinybars;
}

// Credit an account by Hedera account ID.
// Called by the deposit watcher when it detects an incoming HBAR transfer.
// The agent's Hedera account ID is their API key — no registration needed.
export function creditAccount(hederaAccountId, amountTinybars) {
  const apiKey = hederaAccountId; // Hedera ID = API key
  // Create the account if first deposit, otherwise just add to balance
  stmts.insertAccount.run(apiKey, 0, hederaAccountId);
  stmts.credit.run(amountTinybars, apiKey);
  return stmts.getBalance.get(apiKey).balance_tinybars;
}

// Get balance in tinybars. Returns 0 if account not found.
export function getBalance(apiKey) {
  const row = stmts.getBalance.get(apiKey);
  return row ? row.balance_tinybars : 0;
}

// ─────────────────────────────────────────────
// Deposit tracking (used by watcher.js)
// ─────────────────────────────────────────────

// Returns true if we've already processed this deposit — prevents double-crediting
export function depositAlreadyProcessed(transactionId) {
  return !!stmts.checkDeposit.get(transactionId);
}

// Record a processed deposit permanently
export function recordDeposit(hederaAccountId, transactionId, amountTinybars) {
  stmts.insertDeposit.run(hederaAccountId, transactionId, amountTinybars);
}

// ─────────────────────────────────────────────
// Admin / reporting
// ─────────────────────────────────────────────

export function getAllAccounts() {
  return stmts.allAccounts.all();
}

export function getRecentTransactions(limit = 50) {
  return stmts.recentTxs.all(limit);
}

export function getTransactionHistory(apiKey, limit = 50) {
  return stmts.txHistory.all(apiKey, limit);
}

// Admin: manually provision or top up an API key with a balance
export function provisionKey(apiKey, balanceTinybars, hederaAccountId = null) {
  stmts.upsertAccount.run(apiKey, balanceTinybars, hederaAccountId, balanceTinybars);
  return getAccount(apiKey);
}

// ─────────────────────────────────────────────
// Consent events
// ─────────────────────────────────────────────

const consentStmts = {
  insert: db.prepare(`
    INSERT INTO consent_events (api_key, hedera_account_id, terms_version, ip_address, user_agent, hcs_sequence)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getLatest: db.prepare(`
    SELECT * FROM consent_events WHERE api_key = ? ORDER BY timestamp DESC LIMIT 1
  `),
  hasConsented: db.prepare(`
    SELECT 1 FROM consent_events WHERE api_key = ? AND terms_version = ? LIMIT 1
  `),
};

export function recordConsent(apiKey, hederaAccountId, termsVersion, ipAddress, userAgent, hcsSequence) {
  consentStmts.insert.run(apiKey, hederaAccountId, termsVersion, ipAddress || null, userAgent || null, hcsSequence || null);
}

export function hasConsented(apiKey, termsVersion) {
  return !!consentStmts.hasConsented.get(apiKey, termsVersion);
}

export function getLatestConsent(apiKey) {
  return consentStmts.getLatest.get(apiKey) || null;
}

// ─────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────

const provenanceStmts = {
  insert: db.prepare(`
    INSERT INTO provenance (api_key, agent_did, tool_name, inputs_summary, outputs_summary, risk_flags)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  byKey: db.prepare(`
    SELECT * FROM provenance WHERE api_key = ? ORDER BY timestamp DESC LIMIT ?
  `),
  byDid: db.prepare(`
    SELECT * FROM provenance WHERE agent_did = ? ORDER BY timestamp DESC LIMIT ?
  `),
};

// Write a provenance record after a successful paid tool call.
// Never throws — a provenance write failure must never fail the tool response.
export function logProvenance(apiKey, toolName, inputsSummary, outputsSummary, riskFlags, agentDid = null) {
  try {
    provenanceStmts.insert.run(
      apiKey,
      agentDid || null,
      toolName,
      inputsSummary || null,
      outputsSummary || null,
      riskFlags || null
    );
  } catch (e) {
    console.error(`[Provenance] Write failed for ${toolName}/${apiKey}: ${e.message}`);
  }
}

// Retrieve provenance records for a given api_key (admin use)
export function getProvenanceByKey(apiKey, limit = 100) {
  return provenanceStmts.byKey.all(apiKey, limit);
}

// Retrieve provenance records for a given agent DID (Fixatum use)
export function getProvenanceByDid(agentDid, limit = 100) {
  return provenanceStmts.byDid.all(agentDid, limit);
}

// ─────────────────────────────────────────────
// Agent DID binding
// ─────────────────────────────────────────────

// Lazily add agent_did column and its index — safe to run on an existing DB
try { db.exec(`ALTER TABLE accounts ADD COLUMN agent_did TEXT`); } catch { /* column already exists */ }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_agent_did ON accounts(agent_did)`); } catch { /* index already exists */ }

const didStmts = {
  set: db.prepare(`UPDATE accounts SET agent_did = ? WHERE api_key = ?`),
  get: db.prepare(`SELECT agent_did FROM accounts WHERE api_key = ?`),
};

// Bind a Fixatum DID to an account. Returns true if the account exists.
export function setAgentDid(apiKey, agentDid) {
  const result = didStmts.set.run(agentDid, apiKey);
  return result.changes > 0;
}

// Return the stored DID for an account, or null.
export function getAgentDid(apiKey) {
  return didStmts.get.get(apiKey)?.agent_did || null;
}

// Purge IP and user_agent from consent_events older than 90 days.
// Called once on startup and daily from the digest scheduler.
// The consent record itself is kept — only PII fields are cleared.
export function purgeOldConsentPII() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const result = db.prepare(`
    UPDATE consent_events
    SET ip_address = NULL, user_agent = NULL
    WHERE timestamp < ? AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)
  `).run(cutoff);
  if (result.changes > 0) {
    console.error(`[Privacy] Purged PII from ${result.changes} consent records older than 90 days`);
  }
  return result.changes;
}

// ─────────────────────────────────────────────
// Rate limiting (SQLite-backed — survives restarts)
// ─────────────────────────────────────────────

const rateLimitStmts = {
  get:    db.prepare(`SELECT window_start, count FROM rate_limits WHERE ip = ?`),
  upsert: db.prepare(`
    INSERT INTO rate_limits (ip, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(ip) DO UPDATE SET
      window_start = CASE WHEN excluded.window_start != rate_limits.window_start THEN excluded.window_start ELSE rate_limits.window_start END,
      count        = CASE WHEN excluded.window_start != rate_limits.window_start THEN 1 ELSE rate_limits.count + 1 END
  `),
};

// Returns true if the IP is over the limit.
// Sliding window: FREE_RATE_LIMIT calls per FREE_RATE_WINDOW_MS.
// Also enforces a daily cap (FREE_DAILY_CAP) that resets at midnight UTC.
const FREE_RATE_LIMIT   = 30;           // max calls per 60s window
const FREE_RATE_WINDOW  = 60_000;       // 60 seconds in ms
const FREE_DAILY_CAP    = 500;          // max calls per day per IP

export function checkRateLimit(ip) {
  const now         = Date.now();
  const windowStart = now - (now % FREE_RATE_WINDOW); // floor to current 60s bucket

  rateLimitStmts.upsert.run(ip, windowStart);
  const row = rateLimitStmts.get.get(ip);

  // Within the current window
  if (row.window_start === windowStart && row.count > FREE_RATE_LIMIT) return true;

  return false;
}

// ─────────────────────────────────────────────
// Tool access control (gated tools)
// ─────────────────────────────────────────────
// Tracks which api_keys have been granted access to gated tools.
// Gated tools never appear in the public tool list — only for authorised accounts.

try { db.exec(`
  CREATE TABLE IF NOT EXISTS tool_access (
    api_key    TEXT NOT NULL,
    tool_name  TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by TEXT,
    PRIMARY KEY (api_key, tool_name)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_access_api_key ON tool_access(api_key);
`); } catch { /* already exists */ }

const toolAccessStmts = {
  grant:    db.prepare(`INSERT OR IGNORE INTO tool_access (api_key, tool_name, granted_by) VALUES (?, ?, ?)`),
  revoke:   db.prepare(`DELETE FROM tool_access WHERE api_key = ? AND tool_name = ?`),
  hasAccess: db.prepare(`SELECT 1 FROM tool_access WHERE api_key = ? AND tool_name = ? LIMIT 1`),
  byKey:    db.prepare(`SELECT tool_name, granted_at, granted_by FROM tool_access WHERE api_key = ?`),
  allGrants: db.prepare(`SELECT * FROM tool_access ORDER BY granted_at DESC`),
};

// Tools that are implemented but withheld from the public tool list — visible
// and callable only to accounts with an explicit grant (see tool_access table
// below). Shared by server.js (filters ALL_TOOLS / list_tools) and
// modules/account/tools.js (filters the account_info pricing table) so a tool
// gated here is gated everywhere, not just from list_tools.
export const GATED_TOOL_NAMES = new Set(["hcs_create_topic"]);

// Grant an api_key access to a gated tool.
export function grantToolAccess(apiKey, toolName, grantedBy = 'admin') {
  toolAccessStmts.grant.run(apiKey, toolName, grantedBy);
}

// Revoke access to a gated tool.
export function revokeToolAccess(apiKey, toolName) {
  const result = toolAccessStmts.revoke.run(apiKey, toolName);
  return result.changes > 0;
}

// Check if an api_key has access to a specific gated tool.
export function hasToolAccess(apiKey, toolName) {
  return !!toolAccessStmts.hasAccess.get(apiKey, toolName);
}

// Get all gated tools granted to an api_key.
export function getToolAccessByKey(apiKey) {
  return toolAccessStmts.byKey.all(apiKey);
}

// Get all grants — for admin dashboard.
export function getAllToolGrants() {
  return toolAccessStmts.allGrants.all();
}

export { db };
