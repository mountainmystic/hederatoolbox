// identity/tools.js - Verified Identity Resolution tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export const IDENTITY_TOOL_DEFINITIONS = [
  {
    name: "identity_resolve",
    description: "Resolve a Hedera account ID to its on-chain identity profile including account age, token holdings, transaction history, and any HCS-based identity records. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Hedera account ID to resolve (e.g. 0.0.123456)" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["account_id", "api_key"],
    },
  },
  {
    name: "identity_verify_kyc",
    description: "Check the KYC status of a Hedera account for one or more tokens. Returns KYC grant status and verification history. Costs 0.2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Hedera account ID to check KYC for" },
        token_id: { type: "string", description: "Optional token ID to check KYC status for a specific token" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["account_id", "api_key"],
    },
  },
  {
    name: "identity_check_sanctions",
    description: "Screen a Hedera account against on-chain risk signals including transaction patterns, counterparty risk, and known flagged accounts. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Hedera account ID to screen" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["account_id", "api_key"],
    },
  },
];

export async function executeIdentityTool(name, args) {

  // --- identity_resolve ---
  if (name === "identity_resolve") {
    const payment = chargeForTool("identity_resolve", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch account info
    const accountRes = await axios.get(`${base}/api/v1/accounts/${args.account_id}`);
    const account = accountRes.data;

    // Fetch token balances
    const tokenRes = await axios.get(
      `${base}/api/v1/accounts/${args.account_id}/tokens?limit=50&order=desc`
    ).catch(() => ({ data: { tokens: [] } }));
    const tokens = tokenRes.data.tokens || [];

    // Fetch recent transactions
    const txRes = await axios.get(
      `${base}/api/v1/transactions?account.id=${args.account_id}&limit=25&order=desc`
    ).catch(() => ({ data: { transactions: [] } }));
    const transactions = txRes.data.transactions || [];

    // Fetch NFT holdings
    const nftRes = await axios.get(
      `${base}/api/v1/accounts/${args.account_id}/nfts?limit=25&order=desc`
    ).catch(() => ({ data: { nfts: [] } }));
    const nfts = nftRes.data.nfts || [];

    // Calculate account age
    const createdAt = account.created_timestamp
      ? new Date(parseFloat(account.created_timestamp) * 1000)
      : null;
    const ageMs = createdAt ? Date.now() - createdAt.getTime() : null;
    const ageDays = ageMs ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;

    // Transaction type breakdown
    const txTypes = {};
    for (const tx of transactions) {
      const t = tx.name || "UNKNOWN";
      txTypes[t] = (txTypes[t] || 0) + 1;
    }

    // Staking info
    const stakingInfo = account.staked_node_id !== null && account.staked_node_id !== undefined
      ? { staked_node: account.staked_node_id, staked_account: account.staked_account_id || null }
      : null;

    return {
      account_id: args.account_id,
      alias: account.alias || null,
      evm_address: account.evm_address || null,
      hbar_balance: account.balance?.balance
        ? (account.balance.balance / 100000000).toFixed(4) + " HBAR"
        : "unknown",
      account_age_days: ageDays,
      created_at: createdAt ? createdAt.toISOString() : null,
      memo: account.memo || null,
      receiver_sig_required: account.receiver_sig_required || false,
      max_auto_token_associations: account.max_automatic_token_associations || 0,
      token_count: tokens.length,
      nft_count: nfts.length,
      recent_transaction_count: transactions.length,
      transaction_type_breakdown: txTypes,
      staking: stakingInfo,
      key_type: account.key?._type || null,
      tokens: tokens.slice(0, 10).map(t => ({
        token_id: t.token_id,
        balance: t.balance,
        kyc_status: t.kyc_status || "NOT_APPLICABLE",
        freeze_status: t.freeze_status || "NOT_APPLICABLE",
      })),
      identity_summary: ageDays > 365
        ? "Established account - over 1 year old with transaction history."
        : ageDays > 30
        ? "Active account - between 1 month and 1 year old."
        : "New account - less than 30 days old.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- identity_verify_kyc ---
  if (name === "identity_verify_kyc") {
    const payment = chargeForTool("identity_verify_kyc", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch account token relationships
    const tokenRes = await axios.get(
      `${base}/api/v1/accounts/${args.account_id}/tokens?limit=100&order=desc`
    ).catch(() => ({ data: { tokens: [] } }));
    const tokens = tokenRes.data.tokens || [];

    // Filter by token_id if provided
    const filtered = args.token_id
      ? tokens.filter(t => t.token_id === args.token_id)
      : tokens;

    const kycResults = filtered.map(t => ({
      token_id: t.token_id,
      kyc_status: t.kyc_status || "NOT_APPLICABLE",
      kyc_granted: t.kyc_status === "GRANTED",
      freeze_status: t.freeze_status || "NOT_APPLICABLE",
      balance: t.balance,
    }));

    const grantedCount = kycResults.filter(r => r.kyc_granted).length;
    const revokedCount = kycResults.filter(r => r.kyc_status === "REVOKED").length;
    const notApplicableCount = kycResults.filter(r => r.kyc_status === "NOT_APPLICABLE").length;

    // Fetch account info for context
    const accountRes = await axios.get(`${base}/api/v1/accounts/${args.account_id}`)
      .catch(() => ({ data: {} }));
    const account = accountRes.data;

    return {
      account_id: args.account_id,
      token_filter: args.token_id || null,
      total_token_relationships: tokens.length,
      kyc_summary: {
        granted: grantedCount,
        revoked: revokedCount,
        not_applicable: notApplicableCount,
        total_checked: kycResults.length,
      },
      kyc_details: kycResults,
      account_memo: account.memo || null,
      note: notApplicableCount === kycResults.length
        ? "All tokens show NOT_APPLICABLE - these tokens do not use Hedera KYC keys."
        : grantedCount > 0
        ? "Account has KYC granted for " + grantedCount + " token(s)."
        : "No KYC grants found for this account.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- identity_check_sanctions ---
  if (name === "identity_check_sanctions") {
    const payment = chargeForTool("identity_check_sanctions", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch account info
    const accountRes = await axios.get(`${base}/api/v1/accounts/${args.account_id}`);
    const account = accountRes.data;

    // Fetch recent transactions for pattern analysis
    const txRes = await axios.get(
      `${base}/api/v1/transactions?account.id=${args.account_id}&limit=100&order=desc`
    ).catch(() => ({ data: { transactions: [] } }));
    const transactions = txRes.data.transactions || [];

    // Fetch token balances
    const tokenRes = await axios.get(
      `${base}/api/v1/accounts/${args.account_id}/tokens?limit=100`
    ).catch(() => ({ data: { tokens: [] } }));
    const tokens = tokenRes.data.tokens || [];

    // Collect unique counterparties
    const counterparties = new Set();
    const txTypes = {};
    let failedTxCount = 0;
    let largeTransferCount = 0;

    for (const tx of transactions) {
      const t = tx.name || "UNKNOWN";
      txTypes[t] = (txTypes[t] || 0) + 1;
      if (tx.result && tx.result !== "SUCCESS") failedTxCount++;
      for (const transfer of tx.transfers || []) {
        if (transfer.account !== args.account_id) {
          counterparties.add(transfer.account);
        }
        if (Math.abs(transfer.amount || 0) > 100000000000) {
          largeTransferCount++;
        }
      }
    }

    // Risk signal detection
    const riskSignals = [];
    let riskScore = 0;

    // Account age check
    const createdAt = account.created_timestamp
      ? new Date(parseFloat(account.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    if (ageDays !== null && ageDays < 7) {
      riskScore += 20;
      riskSignals.push("Very new account - created less than 7 days ago");
    }

    if (failedTxCount > 5) {
      riskScore += 15;
      riskSignals.push("High failed transaction rate - " + failedTxCount + " failed transactions");
    }

    if (largeTransferCount > 3) {
      riskScore += 15;
      riskSignals.push("Multiple large transfers detected (over 1000 HBAR each)");
    }

    if (counterparties.size > 50) {
      riskScore += 10;
      riskSignals.push("High counterparty count - interacts with many unique accounts");
    }

    const frozenTokens = tokens.filter(t => t.freeze_status === "FROZEN");
    if (frozenTokens.length > 0) {
      riskScore += 25;
      riskSignals.push("Account has " + frozenTokens.length + " frozen token relationship(s)");
    }

    const revokedKyc = tokens.filter(t => t.kyc_status === "REVOKED");
    if (revokedKyc.length > 0) {
      riskScore += 30;
      riskSignals.push("KYC has been REVOKED for " + revokedKyc.length + " token(s)");
    }

    if (account.balance?.balance === 0 && transactions.length > 10) {
      riskScore += 10;
      riskSignals.push("Zero HBAR balance despite significant transaction history");
    }

    if (riskSignals.length === 0) {
      riskSignals.push("No on-chain risk signals detected");
    }

    const riskLevel = riskScore >= 50 ? "HIGH" : riskScore >= 20 ? "MEDIUM" : "LOW";

    return {
      account_id: args.account_id,
      screening_result: riskLevel === "HIGH" ? "FLAGGED" : riskLevel === "MEDIUM" ? "REVIEW" : "CLEAR",
      risk_score: riskScore,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      account_profile: {
        age_days: ageDays,
        hbar_balance: account.balance?.balance
          ? (account.balance.balance / 100000000).toFixed(4) + " HBAR"
          : "unknown",
        total_transactions_sampled: transactions.length,
        failed_transactions: failedTxCount,
        unique_counterparties: counterparties.size,
        large_transfers: largeTransferCount,
        token_relationships: tokens.length,
        frozen_tokens: frozenTokens.length,
        kyc_revoked_tokens: revokedKyc.length,
      },
      disclaimer: "This screening is based on on-chain data patterns only. It does not constitute legal sanctions screening and should not be used as a sole compliance determination.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown identity tool: ${name}`);
}