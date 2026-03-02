// bridge/tools.js - Cross-Network Bridge Intelligence tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

// Known bridge contracts and accounts on Hedera mainnet
const KNOWN_BRIDGES = {
  "0.0.1117100": { name: "HashPort Bridge", network: "Ethereum", type: "lock-and-mint" },
  "0.0.1117101": { name: "HashPort Bridge", network: "Polygon", type: "lock-and-mint" },
  "0.0.1456985": { name: "WHBAR Contract", network: "Hedera EVM", type: "wrap" },
};

// Known wrapped/bridged tokens on Hedera
const BRIDGED_TOKENS = {
  "0.0.1460200": { name: "HBARX", source: "Stader", type: "liquid-staking" },
  "0.0.731861":  { name: "SAUCE", source: "SaucerSwap", type: "native" },
  "0.0.1456986": { name: "WHBAR", source: "SaucerSwap", type: "wrapped-native" },
  "0.0.541564":  { name: "WETH[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.1055483": { name: "WBTC[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.1055498": { name: "AAVE[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.540318":  { name: "WMATIC[hts]", source: "HashPort", type: "bridged", origin_network: "Polygon" },
};

export const BRIDGE_TOOL_DEFINITIONS = [
  {
    name: "bridge_status",
    description: "Get the current status of Hedera bridge infrastructure including known bridge contracts, wrapped token registry, and bridge health indicators. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        bridge_id: { type: "string", description: "Optional specific bridge contract ID or token ID to check status for" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["api_key"],
    },
  },
  {
    name: "bridge_transfers",
    description: "Monitor recent bridge transfer activity for a specific bridged token or bridge contract on Hedera. Returns transfer volume, frequency, and counterparty analysis. Costs 0.2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID of a bridged asset to monitor (e.g. USDC, WETH)" },
        limit: { type: "number", description: "Number of recent transfers to analyze (default 50, max 100)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "bridge_analyze",
    description: "Deep analysis of cross-network bridge activity for a token including peg stability, mint/burn ratio, custodian concentration, and bridge risk assessment. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID of a bridged asset to analyze" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
];

export async function executeBridgeTool(name, args) {

  // --- bridge_status ---
  if (name === "bridge_status") {
    const payment = chargeForTool("bridge_status", args.api_key);
    const base = getMirrorNodeBase();

    let specificStatus = null;
    if (args.bridge_id) {
      const knownBridge = KNOWN_BRIDGES[args.bridge_id];
      const knownToken = BRIDGED_TOKENS[args.bridge_id];
      if (knownBridge || knownToken) {
        const infoRes = await axios.get(`${base}/api/v1/tokens/${args.bridge_id}`)
          .catch(() => axios.get(`${base}/api/v1/contracts/${args.bridge_id}`))
          .catch(() => ({ data: null }));
        specificStatus = {
          id: args.bridge_id,
          known_bridge: knownBridge || null,
          known_token: knownToken || null,
          on_chain_info: infoRes.data,
        };
      }
    }

    const tokenChecks = await Promise.all(
      Object.entries(BRIDGED_TOKENS).map(async ([id, info]) => {
        try {
          const res = await axios.get(`${base}/api/v1/tokens/${id}`);
          const token = res.data;
          const decimals = parseInt(token.decimals || 0);
          const supply = parseInt(token.total_supply || 0);
          return {
            token_id: id,
            name: info.name,
            type: info.type,
            source: info.source,
            origin_network: info.origin_network || "Hedera-native",
            total_supply: supply,
            decimals,
            supply_formatted: (supply / Math.pow(10, decimals)).toLocaleString(),
            treasury: token.treasury_account_id,
            pause_status: token.pause_status || "NOT_APPLICABLE",
            status: token.deleted ? "DELETED" : "ACTIVE",
          };
        } catch (e) {
          return {
            token_id: id,
            name: info.name,
            type: info.type,
            source: info.source,
            status: "UNAVAILABLE",
            error: e.message,
          };
        }
      })
    );

    const activeTokens = tokenChecks.filter(t => t.status === "ACTIVE").length;
    const totalTokens = tokenChecks.length;

    return {
      bridge_ecosystem_health: activeTokens === totalTokens ? "HEALTHY" : activeTokens > totalTokens / 2 ? "DEGRADED" : "UNHEALTHY",
      active_bridged_tokens: activeTokens,
      total_tracked_tokens: totalTokens,
      known_bridge_contracts: Object.entries(KNOWN_BRIDGES).map(([id, info]) => ({
        contract_id: id,
        ...info,
      })),
      bridged_token_registry: tokenChecks,
      specific_query: specificStatus,
      note: "Bridge data is derived from on-chain Hedera mirror node data and a curated registry of known bridge contracts and wrapped tokens.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- bridge_transfers ---
  if (name === "bridge_transfers") {
    const payment = chargeForTool("bridge_transfers", args.api_key);
    const base = getMirrorNodeBase();
    const limit = Math.min(args.limit || 50, 100);

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const formatAmount = (raw) => (Math.abs(raw) / Math.pow(10, decimals)).toFixed(decimals);

    // Fetch token transfers directly using the token-specific endpoint
    const txRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?account.balance.gt=0&limit=${limit}`
    ).catch(() => ({ data: { balances: [] } }));
    const topHolders = (txRes.data.balances || [])
      .filter(b => b.balance > 0)
      .sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

    // Fetch recent transactions involving this token via mirror node token transfers
    const transfersRes = await axios.get(
      `${base}/api/v1/transactions?limit=${limit}&order=desc&transactiontype=CRYPTOTRANSFER`
    ).catch(() => ({ data: { transactions: [] } }));
    const allTxs = transfersRes.data.transactions || [];

    const transfers = allTxs.flatMap(tx =>
      (tx.token_transfers || [])
        .filter(tt => tt.token_id === args.token_id)
        .map(tt => ({
          consensus_timestamp: tx.consensus_timestamp,
          account: tt.account,
          amount: tt.amount,
          is_approval: tt.is_approval || false,
        }))
    );

    const senders = {};
    const receivers = {};
    let totalVolume = 0;

    for (const t of transfers) {
      const amount = Math.abs(t.amount || 0);
      totalVolume += amount;
      if (t.amount > 0) {
        receivers[t.account] = (receivers[t.account] || 0) + amount;
      } else {
        senders[t.account] = (senders[t.account] || 0) + amount;
      }
    }

    const topSenders = Object.entries(senders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([account, amount]) => ({
        account,
        volume_formatted: formatAmount(amount) + " " + token.symbol,
      }));

    const topReceivers = Object.entries(receivers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([account, amount]) => ({
        account,
        volume_formatted: formatAmount(amount) + " " + token.symbol,
      }));

    const tsArr = transfers.map(t => parseFloat(t.consensus_timestamp)).filter(Boolean);
    const timeRangeHours = tsArr.length > 1
      ? ((Math.max(...tsArr) - Math.min(...tsArr)) / 3600).toFixed(1)
      : null;

    const bridgeInfo = BRIDGED_TOKENS[args.token_id] || null;

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      bridge_info: bridgeInfo,
      total_supply: parseInt(token.total_supply || 0),
      top_holders: topHolders.slice(0, 10).map(h => ({
        account: h.account,
        balance_formatted: formatAmount(h.balance) + " " + token.symbol,
      })),
      transfers_found: transfers.length,
      transactions_scanned: allTxs.length,
      time_range_hours: timeRangeHours,
      volume_summary: {
        total_volume_formatted: formatAmount(totalVolume) + " " + token.symbol,
        unique_senders: Object.keys(senders).length,
        unique_receivers: Object.keys(receivers).length,
      },
      top_senders: topSenders,
      top_receivers: topReceivers,
      recent_transfers: transfers.slice(0, 10).map(t => ({
        consensus_timestamp: t.consensus_timestamp,
        account: t.account,
        amount_formatted: formatAmount(t.amount) + " " + token.symbol,
        direction: t.amount > 0 ? "IN" : "OUT",
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- bridge_analyze ---
  if (name === "bridge_analyze") {
    const payment = chargeForTool("bridge_analyze", args.api_key);
    const base = getMirrorNodeBase();

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);
    const formatAmount = (raw) => (Math.abs(raw) / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: decimals });

    const holdersRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=50&account.balance.gt=0`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = (holdersRes.data.balances || [])
      .filter(h => h.balance > 0)
      .sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

    const txRes = await axios.get(
      `${base}/api/v1/transactions?limit=100&order=desc&transactiontype=CRYPTOTRANSFER`
    ).catch(() => ({ data: { transactions: [] } }));
    const allTxs = txRes.data.transactions || [];

    const transfers = allTxs.flatMap(tx =>
      (tx.token_transfers || [])
        .filter(tt => tt.token_id === args.token_id)
        .map(tt => ({
          consensus_timestamp: tx.consensus_timestamp,
          account: tt.account,
          amount: tt.amount,
        }))
    );

    const bridgeInfo = BRIDGED_TOKENS[args.token_id] || null;

    const treasury = token.treasury_account_id;
    const treasuryBalance = holders.find(h => h.account === treasury)?.balance || 0;
    const treasuryPct = totalSupply > 0 ? ((treasuryBalance / totalSupply) * 100).toFixed(2) : "0";
    const top3Balance = holders.slice(0, 3).reduce((sum, h) => sum + (h.balance || 0), 0);
    const top3Pct = totalSupply > 0 ? ((top3Balance / totalSupply) * 100).toFixed(2) : "0";

    const tsArr = transfers.map(t => parseFloat(t.consensus_timestamp)).filter(Boolean);
    const timeRangeHours = tsArr.length > 1
      ? Math.max(1, (Math.max(...tsArr) - Math.min(...tsArr)) / 3600)
      : 1;
    const transfersPerHour = (transfers.length / timeRangeHours).toFixed(2);

    let totalInflow = 0;
    let totalOutflow = 0;
    for (const t of transfers) {
      if (t.amount > 0) totalInflow += t.amount;
      else totalOutflow += Math.abs(t.amount);
    }
    const netFlow = totalInflow - totalOutflow;
    const flowRatio = totalOutflow > 0 ? (totalInflow / totalOutflow).toFixed(3) : "inf";

    const createdAt = token.created_timestamp
      ? new Date(parseFloat(token.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const riskSignals = [];
    let riskScore = 0;

    if (parseFloat(top3Pct) > 70) { riskScore += 25; riskSignals.push("Top 3 holders control over 70% of supply - high custodian concentration"); }
    if (parseFloat(treasuryPct) > 50) { riskScore += 20; riskSignals.push("Treasury holds over 50% of total supply - centralised custody risk"); }
    if (!token.admin_key && bridgeInfo?.type === "bridged") { riskScore += 10; riskSignals.push("No admin key - bridged token is immutable (cannot be paused in emergency)"); }
    if (token.pause_status === "PAUSED") { riskScore += 40; riskSignals.push("Token is currently PAUSED - bridge may be halted"); }
    if (token.freeze_key) { riskSignals.push("Freeze key exists - bridge operator can freeze individual accounts"); }
    if (token.wipe_key) { riskScore += 15; riskSignals.push("Wipe key exists - bridge operator can wipe balances"); }
    if (ageDays !== null && ageDays < 30) { riskScore += 15; riskSignals.push("Token is less than 30 days old - new bridge deployment"); }
    if (riskSignals.length === 0) riskSignals.push("No significant bridge risk signals detected");

    const riskLevel = riskScore >= 50 ? "HIGH" : riskScore >= 20 ? "MEDIUM" : "LOW";

    let pegType = "unclassified";
    if (bridgeInfo?.type === "wrapped-native") pegType = "wrapped-native";
    else if (bridgeInfo?.type === "bridged") pegType = "cross-chain-peg";
    else if (bridgeInfo?.type === "liquid-staking") pegType = "liquid-staking-derivative";
    else if (bridgeInfo?.type === "native") pegType = "native-token";

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      bridge_info: bridgeInfo,
      peg_type: pegType,
      age_days: ageDays,
      total_supply_formatted: formatAmount(totalSupply) + " " + token.symbol,
      treasury_account: treasury,
      custodian_analysis: {
        treasury_balance_pct: treasuryPct + "%",
        top_3_holders_pct: top3Pct + "%",
        total_holders_sampled: holders.length,
        top_holders: holders.slice(0, 5).map(h => ({
          account: h.account,
          balance_formatted: formatAmount(h.balance) + " " + token.symbol,
          pct_of_supply: totalSupply > 0 ? ((h.balance / totalSupply) * 100).toFixed(2) + "%" : "unknown",
        })),
      },
      transfer_velocity: {
        transfers_per_hour: transfersPerHour,
        transfers_found: transfers.length,
        transactions_scanned: allTxs.length,
        time_range_hours: timeRangeHours.toFixed(1),
      },
      flow_analysis: {
        total_inflow_formatted: formatAmount(totalInflow) + " " + token.symbol,
        total_outflow_formatted: formatAmount(totalOutflow) + " " + token.symbol,
        net_flow_formatted: formatAmount(Math.abs(netFlow)) + " " + token.symbol + (netFlow >= 0 ? " net inflow" : " net outflow"),
        inflow_outflow_ratio: flowRatio,
      },
      token_controls: {
        admin_key: !!token.admin_key,
        freeze_key: !!token.freeze_key,
        wipe_key: !!token.wipe_key,
        pause_key: !!token.pause_key,
        kyc_key: !!token.kyc_key,
        pause_status: token.pause_status || "NOT_APPLICABLE",
      },
      risk_assessment: {
        score: riskScore,
        level: riskLevel,
        signals: riskSignals,
      },
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown bridge tool: ${name}`);
}
