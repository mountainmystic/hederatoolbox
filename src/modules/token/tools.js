// token/tools.js - Token & DeFi Intelligence tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

const SAUCERSWAP_API = "https://api.saucerswap.finance";

function saucerHeaders() {
  const key = process.env.SAUCERSWAP_API_KEY;
  if (!key) console.warn("[SaucerSwap] WARNING: SAUCERSWAP_API_KEY not set — price data will be unavailable");
  return key ? { "x-api-key": key } : {};
}

async function getSaucerSwapTokens() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/tokens`, { headers: saucerHeaders() });
    return res.data || [];
  } catch (e) {
    return [];
  }
}

async function getSaucerSwapPools() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/pools`, { headers: saucerHeaders() });
    return res.data || [];
  } catch (e) {
    return [];
  }
}

async function getSaucerSwapPriceChange() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/tokens/price-change`, { headers: saucerHeaders() });
    return res.data || {}; // { "0.0.731861": -2.53, ... }
  } catch (e) {
    return {};
  }
}

async function getSaucerSwapDefaultTokens() {
  try {
    const res = await axios.get(`${SAUCERSWAP_API}/tokens/default`, { headers: saucerHeaders() });
    return res.data || []; // includes priceChangeHour/Day/Week and liquidityUsd
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
        api_key: { type: "string", description: "Your HederaIntel API key" },
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
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
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
        api_key: { type: "string", description: "Your HederaIntel API key" },
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

    // Fetch holder count — fetch max and sort client-side by balance desc
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=100&account.balance.gt=0`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = (balRes.data.balances || []).sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

    // Fetch all tokens + price change data in parallel
    const [saucerTokens, priceChangeMap, defaultTokens] = await Promise.all([
      getSaucerSwapTokens(),
      getSaucerSwapPriceChange(),
      getSaucerSwapDefaultTokens(),
    ]);
    const saucerToken = saucerTokens.find(t => t.id === args.token_id);
    const defaultToken = defaultTokens.find(t => t.id === args.token_id);

    // Convert price from tinybars to HBAR
    let priceHbar = null;
    let priceUsd = null;
    if (saucerToken?.price) {
      priceHbar = (parseInt(saucerToken.price) / 100000000).toFixed(8);
      priceUsd = saucerToken.priceUsd || null;
    }

    // 24h price change from /tokens/price-change map
    const rawChange = priceChangeMap[args.token_id];
    const priceChange24h = rawChange != null ? rawChange.toFixed(2) + "%" : null;

    // Extended data from /tokens/default (only available for default-listed tokens)
    const liquidityUsd = defaultToken?.liquidityUsd || null;
    const priceChangeHour = defaultToken?.priceChangeHour != null ? defaultToken.priceChangeHour.toFixed(2) + "%" : null;
    const priceChangeWeek = defaultToken?.priceChangeWeek != null ? defaultToken.priceChangeWeek.toFixed(2) + "%" : null;

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
      price_change_1h_pct: priceChangeHour,
      price_change_24h_pct: priceChange24h,
      price_change_7d_pct: priceChangeWeek,
      liquidity_usd: liquidityUsd ? "$" + liquidityUsd.toLocaleString() : null,
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

    // Holder distribution — fetch max and sort client-side by balance desc
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=100&account.balance.gt=0`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = (balRes.data.balances || []).sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

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

  // --- token_monitor ---
  if (name === "token_monitor") {
    const payment = chargeForTool("token_monitor", args.api_key);
    const base = getMirrorNodeBase();
    const limit = Math.min(args.limit || 25, 100);

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;
    const decimals = parseInt(token.decimals || 0);
    const totalSupply = parseInt(token.total_supply || 0);

    // Fetch holder balances — fetch max and sort client-side by balance desc
    const balRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=100&account.balance.gt=0`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = (balRes.data.balances || []).sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

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