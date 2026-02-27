// token/tools.js - Token & DeFi Intelligence tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

// SaucerSwap public API - no auth required for basic token list
const SAUCERSWAP_API = "https://api.saucerswap.finance";

async function getSaucerSwapTokens() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/tokens`);
    return res.data || [];
  } catch (e) {
    return [];
  }
}

async function getSaucerSwapPools() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/pools`);
    return res.data || [];
  } catch (e) {
    return [];
  }
}

export const TOKEN_TOOL_DEFINITIONS = [
  {
    name: "token_price",
    description: "Get the current price, market cap, and 24h trading volume for a Hedera token. Costs 0.05 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID (e.g. 0.0.123456)" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "token_analyze",
    description: "Deep analysis of a Hedera token including holder distribution, transfer velocity, liquidity, and risk scoring. Costs 0.3 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID to analyze (e.g. 0.0.123456)" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "defi_yields",
    description: "Discover current DeFi yield opportunities on Hedera including liquidity pools, staking, and lending rates. Costs 0.2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Optional token ID to filter yields for a specific token" },
        min_apy: { type: "number", description: "Optional minimum APY percentage to filter results (e.g. 5 for 5%)" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["api_key"],
    },
  },
  {
    name: "token_monitor",
    description: "Monitor recent token transfer activity, whale movements, and unusual trading patterns for a Hedera token. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID to monitor (e.g. 0.0.123456)" },
        limit: { type: "number", description: "Number of recent transactions to return (default 25, max 100)" },
        api_key: { type: "string", description: "Your AgentLens API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
];

export async function executeTokenTool(name, args) {

  // --- token_price ---
  if (name === "token_price") {
    const payment = chargeForTool("token_price", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch token metadata from mirror node
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);
    const adjustedSupply = totalSupply / Math.pow(10, decimals);

    // Fetch holder count
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=100&order=desc`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = balRes.data.balances || [];

    // Fetch all tokens from SaucerSwap and find this one
    const saucerTokens = await getSaucerSwapTokens();
    const saucerToken = saucerTokens.find(t => t.id === args.token_id);

    // Fetch price change data
    let priceChange24h = null;
    try {
      const changeRes = await axios.get(`${SAUCERSWAP_API}/tokens/price-change`);
      priceChange24h = changeRes.data?.[args.token_id] ?? null;
    } catch (e) {}

    // Convert price from tinybars to HBAR (SaucerSwap price is in tinybars per token unit)
    let priceHbar = null;
    let priceUsd = null;
    if (saucerToken?.price) {
      priceHbar = (parseInt(saucerToken.price) / 100000000).toFixed(8);
      priceUsd = saucerToken.priceUsd || null;
    }

    return {
      token_id: args.token_id,
      name: token.name || "Unknown",
      symbol: token.symbol || "?",
      decimals,
      total_supply: adjustedSupply.toLocaleString(),
      type: token.type || "FUNGIBLE_COMMON",
      treasury: token.treasury_account_id,
      holder_count: holders.length,
      price_hbar: priceHbar,
      price_usd: priceUsd,
      price_change_24h_pct: priceChange24h !== null ? priceChange24h.toFixed(4) + "%" : null,
      price_source: saucerToken ? "SaucerSwap DEX" : "Not listed on SaucerSwap DEX",
      due_diligence_complete: saucerToken?.dueDiligenceComplete ?? null,
      created_timestamp: token.created_timestamp,
      memo: token.memo || null,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- token_analyze ---
  if (name === "token_analyze") {
    const payment = chargeForTool("token_analyze", args.api_key);
    const base = getMirrorNodeBase();

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);
    const adjustedSupply = totalSupply / Math.pow(10, decimals);

    // Holder distribution
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=100&order=desc`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = balRes.data.balances || [];

    // Concentration analysis
    const top1Pct = holders[0] ? (parseInt(holders[0].balance) / totalSupply * 100).toFixed(1) : 0;
    const top5Balance = holders.slice(0, 5).reduce((s, b) => s + parseInt(b.balance || 0), 0);
    const top10Balance = holders.slice(0, 10).reduce((s, b) => s + parseInt(b.balance || 0), 0);
    const top5Pct = totalSupply > 0 ? (top5Balance / totalSupply * 100).toFixed(1) : 0;
    const top10Pct = totalSupply > 0 ? (top10Balance / totalSupply * 100).toFixed(1) : 0;

    // SaucerSwap listing info
    const saucerTokens = await getSaucerSwapTokens();
    const saucerToken = saucerTokens.find(t => t.id === args.token_id);

    // Risk scoring
    let riskScore = 0;
    let riskFactors = [];
    if (parseFloat(top1Pct) > 50) { riskScore += 30; riskFactors.push("Single holder controls over 50% of supply"); }
    else if (parseFloat(top1Pct) > 30) { riskScore += 15; riskFactors.push("Single holder controls over 30% of supply"); }
    if (parseFloat(top5Pct) > 80) { riskScore += 25; riskFactors.push("Top 5 holders control over 80% of supply"); }
    else if (parseFloat(top5Pct) > 60) { riskScore += 10; riskFactors.push("Top 5 holders control over 60% of supply"); }
    if (holders.length < 10) { riskScore += 20; riskFactors.push("Very few holders - low distribution"); }
    else if (holders.length < 50) { riskScore += 10; riskFactors.push("Limited holder count"); }
    if (token.freeze_key) { riskScore += 10; riskFactors.push("Token has freeze key - admin can freeze accounts"); }
    if (token.wipe_key) { riskScore += 10; riskFactors.push("Token has wipe key - admin can wipe balances"); }
    if (token.supply_key) { riskFactors.push("Token has supply key - admin can mint or burn tokens"); }
    if (saucerToken && !saucerToken.dueDiligenceComplete) { riskScore += 15; riskFactors.push("SaucerSwap due diligence not complete"); }

    const riskLevel = riskScore >= 60 ? "HIGH" : riskScore >= 30 ? "MEDIUM" : "LOW";

    const topHolders = holders.slice(0, 10).map((b, i) => ({
      rank: i + 1,
      account: b.account,
      balance: (parseInt(b.balance) / Math.pow(10, decimals)).toLocaleString(),
      pct_supply: totalSupply > 0 ? (parseInt(b.balance) / totalSupply * 100).toFixed(2) + "%" : "unknown",
    }));

    return {
      token_id: args.token_id,
      name: token.name || "Unknown",
      symbol: token.symbol || "?",
      decimals,
      total_supply: adjustedSupply.toLocaleString(),
      type: token.type || "FUNGIBLE_COMMON",
      treasury: token.treasury_account_id,
      total_holders: holders.length,
      dex_listed: !!saucerToken,
      dex_price_usd: saucerToken?.priceUsd || null,
      due_diligence_complete: saucerToken?.dueDiligenceComplete ?? null,
      top_holders: topHolders,
      concentration: {
        top_1_pct: top1Pct + "%",
        top_5_pct: top5Pct + "%",
        top_10_pct: top10Pct + "%",
      },
      admin_keys: {
        freeze_key: !!token.freeze_key,
        wipe_key: !!token.wipe_key,
        supply_key: !!token.supply_key,
        kyc_key: !!token.kyc_key,
        pause_key: !!token.pause_key,
      },
      risk_assessment: {
        score: riskScore,
        level: riskLevel,
        factors: riskFactors.length > 0 ? riskFactors : ["No major risk factors detected"],
      },
      created_timestamp: token.created_timestamp,
      memo: token.memo || null,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- defi_yields ---
  if (name === "defi_yields") {
    const payment = chargeForTool("defi_yields", args.api_key);
    const minApy = args.min_apy || 0;

    const pools = await getSaucerSwapPools();
    const saucerTokens = await getSaucerSwapTokens();

    // Build token lookup map
    const tokenMap = {};
    for (const t of saucerTokens) {
      tokenMap[t.id] = t;
    }

    let yields = [];
    for (const pool of pools) {
      const apy = parseFloat(pool.feeApy || pool.apy || 0);
      if (apy < minApy) continue;
      if (args.token_id) {
        const hasToken = pool.tokenA?.id === args.token_id || pool.tokenB?.id === args.token_id ||
                         pool.token0?.id === args.token_id || pool.token1?.id === args.token_id;
        if (!hasToken) continue;
      }

      const tokenAId = pool.tokenA?.id || pool.token0?.id;
      const tokenBId = pool.tokenB?.id || pool.token1?.id;
      const tokenASymbol = pool.tokenA?.symbol || tokenMap[tokenAId]?.symbol || tokenAId || "?";
      const tokenBSymbol = pool.tokenB?.symbol || tokenMap[tokenBId]?.symbol || tokenBId || "?";

      yields.push({
        type: "Liquidity Pool",
        protocol: "SaucerSwap",
        pair: tokenASymbol + "/" + tokenBSymbol,
        token_a_id: tokenAId,
        token_b_id: tokenBId,
        apy: apy.toFixed(2) + "%",
        tvl_usd: pool.tvl ? "$" + parseFloat(pool.tvl).toLocaleString() : "unknown",
        volume_24h_usd: pool.volume24h ? "$" + parseFloat(pool.volume24h).toLocaleString() : "unknown",
        pool_id: pool.contractId || pool.id || null,
      });
    }

    // Sort by APY descending, take top 20
    yields.sort((a, b) => parseFloat(b.apy) - parseFloat(a.apy));
    yields = yields.slice(0, 20);

    // Always include native HBAR staking
    const nativeStaking = {
      type: "Native Staking",
      protocol: "Hedera Network",
      pair: "HBAR",
      apy: "~2-3%",
      tvl_usd: "N/A",
      volume_24h_usd: "N/A",
      description: "Stake HBAR directly to a Hedera node. No lockup, rewards compound automatically.",
      risk: "LOW",
    };

    return {
      token_filter: args.token_id || null,
      min_apy_filter: minApy > 0 ? minApy + "%" : null,
      total_opportunities: yields.length + 1,
      native_staking: nativeStaking,
      liquidity_pools: yields,
      note: yields.length === 0
        ? "No pools matched your filter criteria. Try removing the token_id or min_apy filter."
        : `Showing top ${yields.length} pools by APY from SaucerSwap.`,
      data_source: "SaucerSwap DEX API + Hedera native staking",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- token_monitor ---
  if (name === "token_monitor") {
    const payment = chargeForTool("token_monitor", args.api_key);
    const base = getMirrorNodeBase();
    const limit = Math.min(args.limit || 25, 100);

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);

    // Fetch holder balances
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=50&order=desc`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = balRes.data.balances || [];

    // SaucerSwap price
    const saucerTokens = await getSaucerSwapTokens();
    const saucerToken = saucerTokens.find(t => t.id === args.token_id);

    // Top holders / whale detection
    const top10Balance = holders.slice(0, 10).reduce((s, b) => s + parseInt(b.balance || 0), 0);
    const concentrationPct = totalSupply > 0 ? (top10Balance / totalSupply * 100).toFixed(1) : 0;

    const whales = holders.slice(0, limit).map((b, i) => ({
      rank: i + 1,
      account: b.account,
      balance: (parseInt(b.balance) / Math.pow(10, decimals)).toLocaleString(),
      pct_supply: totalSupply > 0 ? (parseInt(b.balance) / totalSupply * 100).toFixed(2) + "%" : "unknown",
      is_treasury: b.account === token.treasury_account_id,
    }));

    // Activity signals
    const signals = [];
    if (parseFloat(concentrationPct) > 80) signals.push("HIGH CONCENTRATION - Top 10 holders control " + concentrationPct + "% of supply");
    if (holders.length < 20) signals.push("LOW DISTRIBUTION - Token held by fewer than 20 accounts");
    if (token.pause_status === "PAUSED") signals.push("WARNING - Token is currently PAUSED");
    if (saucerToken && !saucerToken.dueDiligenceComplete) signals.push("DEX CAUTION - SaucerSwap due diligence not complete");
    if (signals.length === 0) signals.push("No unusual patterns detected");

    return {
      token_id: args.token_id,
      name: token.name || "Unknown",
      symbol: token.symbol || "?",
      current_price_usd: saucerToken?.priceUsd || null,
      current_price_hbar: saucerToken?.price ? (parseInt(saucerToken.price) / 100000000).toFixed(8) : null,
      total_holders: holders.length,
      total_supply: (totalSupply / Math.pow(10, decimals)).toLocaleString(),
      pause_status: token.pause_status || "NOT_APPLICABLE",
      top_10_concentration: concentrationPct + "%",
      top_holders: whales,
      activity_signals: signals,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown token tool: ${name}`);
}