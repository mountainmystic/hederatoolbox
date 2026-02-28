// watcher.js - Hedera deposit watcher
// Polls the mirror node every 30 seconds for incoming HBAR transfers to the
// platform wallet. When a new deposit is detected, it automatically creates
// an account keyed to the sender's Hedera account ID and credits the balance.
// The sender's Hedera account ID becomes their API key — no registration needed.

import axios from "axios";
import { creditAccount, depositAlreadyProcessed, recordDeposit } from "./db.js";

const PLATFORM_ACCOUNT = process.env.HEDERA_ACCOUNT_ID;   // e.g. 0.0.10298356
const NETWORK          = process.env.HEDERA_NETWORK || "mainnet";
const POLL_INTERVAL_MS = 30_000; // 30 seconds

const MIRROR_BASE = NETWORK === "mainnet"
  ? "https://mainnet-public.mirrornode.hedera.com"
  : "https://testnet.mirrornode.hedera.com";

// We track the timestamp of the last transaction we processed so we only
// fetch genuinely new transactions on each poll.
let lastTimestamp = null;

// ─────────────────────────────────────────────
// Core poll function
// ─────────────────────────────────────────────

async function pollDeposits() {
  try {
    // Build query: CRYPTOTRANSFER transactions involving our account,
    // successful only, newest first, since last seen timestamp
    const params = new URLSearchParams({
      "account.id":       PLATFORM_ACCOUNT,
      transactiontype:    "CRYPTOTRANSFER",
      result:             "SUCCESS",
      order:              "asc",   // oldest first so we process in order
      limit:              "100",
    });

    // On subsequent polls only fetch transactions newer than what we've seen
    if (lastTimestamp) {
      params.set("timestamp", `gt:${lastTimestamp}`);
    } else {
      // First poll: only look back 24 hours to avoid processing ancient history
      const oneDayAgo = (Date.now() / 1000 - 86400).toFixed(9);
      params.set("timestamp", `gt:${oneDayAgo}`);
    }

    const url = `${MIRROR_BASE}/api/v1/transactions?${params}`;
    const response = await axios.get(url, { timeout: 10_000 });
    const transactions = response.data?.transactions || [];

    if (transactions.length === 0) return;

    let newLastTimestamp = lastTimestamp;

    for (const tx of transactions) {
      const txTimestamp = tx.consensus_timestamp;

      // Track the furthest timestamp we've seen
      if (!newLastTimestamp || txTimestamp > newLastTimestamp) {
        newLastTimestamp = txTimestamp;
      }

      // Skip if we've already processed this exact transaction
      if (depositAlreadyProcessed(tx.transaction_id)) continue;

      // Find transfers that are sending HBAR *to* our platform account
      // tx.transfers is an array of { account, amount } where amount is in tinybars
      // Positive amount = receiving, negative = sending
      const incomingTransfers = (tx.transfers || []).filter(
        (t) => t.account === PLATFORM_ACCOUNT && t.amount > 0
      );

      if (incomingTransfers.length === 0) continue;

      // Find who sent it — the account with a negative transfer in this tx
      // that is NOT our platform account and NOT a fee collector (0.0.98 etc.)
      const sender = (tx.transfers || []).find(
        (t) => t.amount < 0 && t.account !== PLATFORM_ACCOUNT && !isSystemAccount(t.account)
      );

      if (!sender) continue;

      const senderAccountId  = sender.account;
      const depositTinybars  = incomingTransfers.reduce((sum, t) => sum + t.amount, 0);

      // Credit the sender's account and record the deposit
      const newBalance = creditAccount(senderAccountId, depositTinybars);
      recordDeposit(senderAccountId, tx.transaction_id, depositTinybars);

      const depositHbar  = (depositTinybars  / 100_000_000).toFixed(4);
      const balanceHbar  = (newBalance / 100_000_000).toFixed(4);

      console.error(
        `[Watcher] Deposit: ${senderAccountId} sent ${depositHbar} HBAR → ` +
        `balance now ${balanceHbar} HBAR (tx: ${tx.transaction_id})`
      );
    }

    // Advance our cursor so next poll only fetches newer transactions
    if (newLastTimestamp && newLastTimestamp !== lastTimestamp) {
      lastTimestamp = newLastTimestamp;
    }

  } catch (err) {
    // Log but never crash — the watcher must keep running even if the mirror
    // node is temporarily unavailable
    console.error(`[Watcher] Poll error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// System account filter
// ─────────────────────────────────────────────

// Hedera system/fee accounts have low IDs. We don't want to credit them.
function isSystemAccount(accountId) {
  if (!accountId) return true;
  const num = parseInt(accountId.split(".").pop(), 10);
  return num < 1000; // accounts below 0.0.1000 are system/node/fee accounts
}

// ─────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────

export function startWatcher() {
  if (!PLATFORM_ACCOUNT) {
    console.error("[Watcher] HEDERA_ACCOUNT_ID not set — deposit watcher disabled");
    return;
  }

  console.error(`[Watcher] Starting — watching ${PLATFORM_ACCOUNT} on ${NETWORK} (${POLL_INTERVAL_MS / 1000}s interval)`);

  // Run immediately on start, then on interval
  pollDeposits();
  const interval = setInterval(pollDeposits, POLL_INTERVAL_MS);

  // Return a stop function in case we ever need to shut it down cleanly
  return () => clearInterval(interval);
}
