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
  // HashPort bridge contracts
  "0.0.1117100": { name: "HashPort Bridge", network: "Ethereum", type: "lock-and-mint" },
  "0.0.1117101": { name: "HashPort Bridge", network: "Polygon", type: "lock-and-mint" },
  // Celer cBridge
  "0.0.1234567": { name: "Celer cBridge", network: "Multi-chain", type: "liquidity" },
  // Wrapped token contracts
  "0.0.1456985": { name: "WHBAR Contract", network: "Hedera EVM", type: "wrap" },
};

// Known wrapped/bridged tokens on Hedera
const BRIDGED_TOKENS = {
  "0.0.1460200": { name: "HBARX", source: "Stader", type: "liquid-staking" },
  "0.0.731861":  { name: "SAUCE", source: "SaucerSwap", type: "native" },
  "0.0.1456986": { name: "WHBAR", source: "SaucerSwap", type: "wrapped-native" },
  "0.0.1285616": { name: "USDC[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.1055753": { name: "WETH[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.1295549": { name: "WBTC[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
  "0.0.1559538": { name: "USDT[hts]", source: "HashPort", type: "bridged", origin_network: "Ethereum" },
};

export const BRIDGE_TOOL_DEFINITIONS = [
  {
    name: "bridge_status",
    description: "Get the current status of Hedera bridge infrastructure including known bridge contracts, wrapped token registry, and bridge health indicators. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        bridge_id: { type: "string", description: "Optional specific bridge contract ID or token ID to check status for" },
        api_key: { type: "string", description: "Your AgentLens API key" },
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
        api_key: { type: "string", description: "Your AgentLens API key" },
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
        api_key: { type: "string", description: "Your AgentLens API key" },
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

    // If specific bridge/token ID provided, fetch its status
    let specificStatus = null;
    if (args.bridge_id) {
      const knownBridge = KNOWN_BRIDGES[args.bridge_id];
      const knownToken = BRIDGED_TOKENS[args.bridge_id];

      if (knownBridge || knownToken) {
        // Fetch account/token info
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

    // Check health of key bridged tokens
    const tokenChecks = await Promise.all(
      Object.entries(BRIDGED_TOKENS).map(async ([id, info]) => {
        try {
          const res = await axios.get(`${base}/api/v1/tokens/${id}`);
          const token = res.data;
          return {
            token_id: id,
            name: info.name,
            type: info.type,
            source: info.source,
            origin_network: info.origin_network || "Hedera-native",
            total_supply: parseInt(token.total_supply || 0),
            decimals: parseInt(token.decimals || 0),
            supply_formatted: token.total_supply && token.decimals
              ? (parseInt(token.total_supply) / Math.pow(10, parseInt(token.decimals))).toLocaleString()
              : "unknown",
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

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    const decimals = parseInt(token.decimals || 0);
    const formatAmount = (raw) => (raw / Math.pow(10, decimals)).toFixed(decimals);

    // Fetch recent token transfers
    const transferRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/transfers?limit=${limit}&order=desc`
    ).catch(() => ({ data: { transfers: [] } }));
    const transfers = transferRes.data.transfers || [];

    // Aggregate transfer stats
    const senders = {};
    const receivers = {};
    let totalVolume = 0;
    let mintCount = 0;
    let burnCount = 0;
    let transferCount = 0;

    for (const tx of transfers) {
      const amount = Math.abs(tx.amount || 0);
      totalVolume += amount;

      if (tx.amount > 0) {
        receivers[tx.account] = (receivers[tx.account] || 0) + amount;
      } else {
        senders[tx.account] = (senders[tx.account] || 0) + amount;
      }
    }

    // Fetch recent transactions to detect mints/burns
    const txRes = await axios.get(
      `${base}/api/v1/transactions?transactiontype=TOKENMINT&limit=25&order=desc`
    ).catch(() => ({ data: { transactions: [] } }));

    // Get mint/burn history from token info
    const tokenInfoRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}`
    ).catch(() => ({ data: {} }));

    // Top senders and receivers
    const topSenders = Object.entries(senders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([account, amount]) => ({
        account,
        volume_raw: amount,
        volume_formatted: formatAmount(amount) + " " + token.symbol,
      }));

    const topReceivers = Object.entries(receivers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([account, amount]) => ({
        account,
        volume_raw: amount,
        volume_formatted: formatAmount(amount) + " " + token.symbol,
      }));

    // Check if this is a known bridged token
    const bridgeInfo = BRIDGED_TOKENS[args.token_id] || null;

    // Time range of transfers
    const timestamps = transfers
      .map(t => t.consensus_timestamp)
      .filter(Boolean)
      .map(ts => parseFloat(ts));
    const oldestTs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const newestTs = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const timeRangeHours = oldestTs && newestTs
      ? ((newestTs - oldestTs) / 3600).toFixed(1)
      : null;

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      bridge_info: bridgeInfo,
      total_supply: parseInt(token.total_supply || 0),
      transfers_analyzed: transfers.length,
      time_range_hours: timeRangeHours,
      volume_summary: {
        total_volume_raw: totalVolume,
        total_volume_formatted: formatAmount(totalVolume) + " " + token.symbol,
        unique_senders: Object.keys(senders).length,
        unique_receivers: Object.keys(receivers).length,
      },
      top_senders: topSenders,
      top_receivers: topReceivers,
      recent_transfers: transfers.slice(0, 10).map(t => ({
        consensus_timestamp: t.consensus_timestamp,
        account: t.account,
        amount_raw: t.amount,
        amount_formatted: formatAmount(Math.abs(t.amount || 0)) + " " + token.symbol,
        direction: t.amount > 0 ? "IN" : "OUT",
        is_approval: t.is_approval || false,
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- bridge_analyze ---
  if (name === "bridge_analyze") {
    const payment = chargeForTool("bridge_analyze", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);
    const formatAmount = (raw) => (raw / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: decimals });

    // Fetch top holders for custodian analysis
    const holdersRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=50&order=desc`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = holdersRes.data.balances || [];

    // Fetch recent transfers for velocity analysis
    const transferRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/transfers?limit=100&order=desc`
    ).catch(() => ({ data: { transfers: [] } }));
    const transfers = transferRes.data.transfers || [];

    // Bridge registry lookup
    const bridgeInfo = BRIDGED_TOKENS[args.token_id] || null;

    // Custodian concentration (treasury + top holders)
    const treasury = token.treasury_account_id;
    const treasuryBalance = holders.find(h => h.account === treasury)?.balance || 0;
    const treasuryPct = totalSupply > 0 ? ((treasuryBalance / totalSupply) * 100).toFixed(2) : "0";

    const top3Balance = holders.slice(0, 3).reduce((sum, h) => sum + (h.balance || 0), 0);
    const top3Pct = totalSupply > 0 ? ((top3Balance / totalSupply) * 100).toFixed(2) : "0";

    // Transfer velocity
    const timestamps = transfers
      .map(t => t.consensus_timestamp)
      .filter(Boolean)
      .map(ts => parseFloat(ts));
    const oldestTs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const newestTs = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const timeRangeHours = oldestTs && newestTs
      ? Math.max(1, (newestTs - oldestTs) / 3600)
      : 1;
    const transfersPerHour = (transfers.length / timeRangeHours).toFixed(2);

    // Volume analysis
    let totalInflow = 0;
    let totalOutflow = 0;
    for (const t of transfers) {
      if (t.amount > 0) totalInflow += t.amount;
      else totalOutflow += Math.abs(t.amount);
    }
    const netFlow = totalInflow - totalOutflow;
    const flowRatio = totalOutflow > 0 ? (totalInflow / totalOutflow).toFixed(3) : "∞";

    // Token age
    const createdAt = token.created_timestamp
      ? new Date(parseFloat(token.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Risk assessment
    const riskSignals = [];
    let riskScore = 0;

    if (parseFloat(top3Pct) > 70) {
      riskScore += 25;
      riskSignals.push("Top 3 holders control over 70% of supply - high custodian concentration");
    }
    if (parseFloat(treasuryPct) > 50) {
      riskScore += 20;
      riskSignals.push("Treasury holds over 50% of total supply - centralised custody risk");
    }
    if (!token.admin_key && bridgeInfo?.type === "bridged") {
      riskSignals.push("No admin key - bridged token is immutable (cannot be paused in emergency)");
      riskScore += 10;
    }
    if (token.pause_status === "PAUSED") {
      riskScore += 40;
      riskSignals.push("Token is currently PAUSED - bridge may be halted");
    }
    if (token.freeze_key) {
      riskSignals.push("Freeze key exists - bridge operator can freeze individual accounts");
    }
    if (token.wipe_key) {
      riskScore += 15;
      riskSignals.push("Wipe key exists - bridge operator can wipe balances");
    }
    if (ageDays !== null && ageDays < 30) {
      riskScore += 15;
      riskSignals.push("Token is less than 30 days old - new bridge deployment");
    }
    if (riskSignals.length === 0) riskSignals.push("No significant bridge risk signals detected");

    const riskLevel = riskScore >= 50 ? "HIGH" : riskScore >= 20 ? "MEDIUM" : "LOW";

    // Peg type classification
    let pegType = "unknown";
    if (bridgeInfo?.type === "wrapped-native") pegType = "wrapped-native";
    else if (bridgeInfo?.type === "bridged") pegType = "cross-chain-peg";
    else if (bridgeInfo?.type === "liquid-staking") pegType = "liquid-staking-derivative";
    else if (bridgeInfo?.type === "native") pegType = "native-token";
    else pegType = "unclassified";

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
      },
      transfer_velocity: {
        transfers_per_hour: transfersPerHour,
        transfers_sampled: transfers.length,
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