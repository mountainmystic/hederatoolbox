// nft/tools.js - NFT & Token Metadata tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export const NFT_TOOL_DEFINITIONS = [
  {
    name: "nft_collection_info",
    description: "Get metadata and stats for an NFT collection on Hedera including supply, royalties, treasury, and token properties. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID for the NFT collection (e.g. 0.0.123456)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "nft_token_metadata",
    description: "Get metadata for a specific NFT serial number including on-chain data, IPFS/metadata URI, and current owner. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID for the NFT collection (e.g. 0.0.123456)" },
        serial_number: { type: "number", description: "Serial number of the specific NFT to look up" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "serial_number", "api_key"],
    },
  },
  {
    name: "nft_collection_analyze",
    description: "Deep analysis of an NFT collection including holder distribution, whale concentration, transfer velocity, floor price signals, and rarity insights. Costs 0.3 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID for the NFT collection to analyze" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "token_holders",
    description: "Get the holder distribution for any Hedera token (fungible or NFT) including top holders, concentration metrics, and whale analysis. Costs 0.2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID to get holder distribution for" },
        limit: { type: "number", description: "Number of top holders to return (default 25, max 100)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
];

export async function executeNFTTool(name, args) {

  // --- nft_collection_info ---
  if (name === "nft_collection_info") {
    const payment = chargeForTool("nft_collection_info", args.api_key);
    const base = getMirrorNodeBase();

    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    // Fetch recent NFT transfers
    const transferRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/nfts?limit=10&order=desc`
    ).catch(() => ({ data: { nfts: [] } }));
    const nfts = transferRes.data.nfts || [];

    // Parse royalties
    const royalties = (token.custom_fees?.royalty_fees || []).map(fee => ({
      numerator: fee.amount?.numerator,
      denominator: fee.amount?.denominator,
      percentage: fee.amount?.numerator && fee.amount?.denominator
        ? ((fee.amount.numerator / fee.amount.denominator) * 100).toFixed(2) + "%"
        : null,
      collector_account: fee.collector_account_id,
      fallback_fee: fee.fallback_fee || null,
    }));

    const fixedFees = (token.custom_fees?.fixed_fees || []).map(fee => ({
      amount: fee.amount,
      denominating_token: fee.denominating_token_id || "HBAR",
      collector_account: fee.collector_account_id,
    }));

    // Token age
    const createdAt = token.created_timestamp
      ? new Date(parseFloat(token.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      type: token.type,
      total_supply: parseInt(token.total_supply || 0),
      max_supply: token.max_supply ? parseInt(token.max_supply) : null,
      supply_type: token.supply_type,
      treasury_account: token.treasury_account_id,
      memo: token.memo || null,
      created_at: createdAt ? createdAt.toISOString() : null,
      age_days: ageDays,
      admin_key: token.admin_key ? true : false,
      freeze_key: token.freeze_key ? true : false,
      kyc_key: token.kyc_key ? true : false,
      supply_key: token.supply_key ? true : false,
      wipe_key: token.wipe_key ? true : false,
      pause_key: token.pause_key ? true : false,
      pause_status: token.pause_status || "NOT_APPLICABLE",
      royalty_fees: royalties,
      fixed_fees: fixedFees,
      has_royalties: royalties.length > 0,
      recently_minted_serials: nfts.slice(0, 5).map(n => ({
        serial: n.serial_number,
        owner: n.account_id,
        created_at: n.created_timestamp
          ? new Date(parseFloat(n.created_timestamp) * 1000).toISOString()
          : null,
        metadata: n.metadata
          ? Buffer.from(n.metadata, "base64").toString("utf8").replace(/\0/g, "").trim()
          : null,
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- nft_token_metadata ---
  if (name === "nft_token_metadata") {
    const payment = chargeForTool("nft_token_metadata", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch specific NFT
    const nftRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/nfts/${args.serial_number}`
    );
    const nft = nftRes.data;

    // Fetch token info for context
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`)
      .catch(() => ({ data: {} }));
    const token = tokenRes.data;

    // Fetch transfer history for this serial
    const txRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/nfts/${args.serial_number}/transactions?limit=10&order=desc`
    ).catch(() => ({ data: { transactions: [] } }));
    const transactions = txRes.data.transactions || [];

    // Decode metadata
    let metadataRaw = null;
    let metadataUri = null;
    if (nft.metadata) {
      metadataRaw = Buffer.from(nft.metadata, "base64").toString("utf8").replace(/\0/g, "").trim();
      // Check if it looks like a URI
      if (metadataRaw.startsWith("ipfs://") || metadataRaw.startsWith("https://") || metadataRaw.startsWith("http://")) {
        metadataUri = metadataRaw;
      }
    }

    // Mint date
    const mintedAt = nft.created_timestamp
      ? new Date(parseFloat(nft.created_timestamp) * 1000)
      : null;

    // Transfer count
    const transferCount = transactions.length;
    const previousOwners = [...new Set(
      transactions
        .map(t => t.sender_account_id)
        .filter(a => a && a !== nft.account_id)
    )];

    return {
      token_id: args.token_id,
      serial_number: args.serial_number,
      collection_name: token.name || null,
      collection_symbol: token.symbol || null,
      current_owner: nft.account_id,
      minted_at: mintedAt ? mintedAt.toISOString() : null,
      deleted: nft.deleted || false,
      spender: nft.spender || null,
      metadata_raw: metadataRaw,
      metadata_uri: metadataUri,
      metadata_type: metadataUri
        ? metadataUri.startsWith("ipfs://") ? "IPFS" : "HTTP"
        : metadataRaw ? "RAW" : "NONE",
      transfer_count: transferCount,
      previous_owners: previousOwners.slice(0, 5),
      transfer_history: transactions.slice(0, 5).map(t => ({
        timestamp: t.consensus_timestamp,
        type: t.type,
        sender: t.sender_account_id,
        receiver: t.receiver_account_id,
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- nft_collection_analyze ---
  if (name === "nft_collection_analyze") {
    const payment = chargeForTool("nft_collection_analyze", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    const totalSupply = parseInt(token.total_supply || 0);

    // Fetch top holders - NFT balances are serial counts; sort client-side by balance desc
    const holdersRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=50&account.balance.gt=0`
    ).catch(() => ({ data: { balances: [] } }));
    const holders = (holdersRes.data.balances || [])
      .filter(h => h.balance > 0)
      .sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

    // Fetch recent NFTs
    const nftsRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/nfts?limit=50&order=desc`
    ).catch(() => ({ data: { nfts: [] } }));
    const nfts = nftsRes.data.nfts || [];

    // Holder concentration
    const totalHolders = holders.length;
    const top1 = holders[0]?.balance || 0;
    const top5 = holders.slice(0, 5).reduce((sum, h) => sum + (h.balance || 0), 0);
    const top10 = holders.slice(0, 10).reduce((sum, h) => sum + (h.balance || 0), 0);

    const top1Pct = totalSupply > 0 ? ((top1 / totalSupply) * 100).toFixed(1) : "0";
    const top5Pct = totalSupply > 0 ? ((top5 / totalSupply) * 100).toFixed(1) : "0";
    const top10Pct = totalSupply > 0 ? ((top10 / totalSupply) * 100).toFixed(1) : "0";

    // Whale detection (holding >5% of supply)
    const whaleThreshold = totalSupply * 0.05;
    const whales = holders.filter(h => h.balance >= whaleThreshold);

    // Transfer velocity — mints per day
    const mintDates = nfts
      .filter(n => n.created_timestamp)
      .map(n => new Date(parseFloat(n.created_timestamp) * 1000));

    let mintsPerDay = null;
    if (mintDates.length > 1) {
      const oldest = Math.min(...mintDates.map(d => d.getTime()));
      const newest = Math.max(...mintDates.map(d => d.getTime()));
      const days = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24));
      mintsPerDay = (mintDates.length / days).toFixed(2);
    }

    // Royalty summary
    const royalties = token.custom_fees?.royalty_fees || [];
    const royaltyPct = royalties.length > 0 && royalties[0].amount
      ? ((royalties[0].amount.numerator / royalties[0].amount.denominator) * 100).toFixed(2) + "%"
      : "0%";

    // Risk signals
    const riskSignals = [];
    let riskScore = 0;

    if (parseFloat(top1Pct) > 50) { riskScore += 30; riskSignals.push("Single holder owns over 50% of supply"); }
    else if (parseFloat(top1Pct) > 20) { riskScore += 15; riskSignals.push("Single holder owns over 20% of supply"); }
    if (parseFloat(top10Pct) > 80) { riskScore += 20; riskSignals.push("Top 10 holders own over 80% of supply"); }
    if (!token.admin_key) riskSignals.push("No admin key - collection is immutable");
    if (token.pause_status === "PAUSED") { riskScore += 25; riskSignals.push("Collection is currently PAUSED"); }
    if (totalSupply < 10) { riskScore += 10; riskSignals.push("Very small supply - less than 10 NFTs"); }
    if (whales.length > 3) { riskScore += 10; riskSignals.push(whales.length + " whale holders detected (each holding >5% of supply)"); }
    if (riskSignals.length === 0) riskSignals.push("No significant risk signals detected");

    const riskLevel = riskScore >= 40 ? "HIGH" : riskScore >= 15 ? "MEDIUM" : "LOW";

    // Token age
    const createdAt = token.created_timestamp
      ? new Date(parseFloat(token.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      total_supply: totalSupply,
      max_supply: token.max_supply ? parseInt(token.max_supply) : null,
      age_days: ageDays,
      royalty_percentage: royaltyPct,
      holder_stats: {
        total_holders_sampled: totalHolders,
        top_1_holder_pct: top1Pct + "%",
        top_5_holders_pct: top5Pct + "%",
        top_10_holders_pct: top10Pct + "%",
        whale_count: whales.length,
      },
      top_holders: holders.slice(0, 10).map(h => ({
        account: h.account,
        balance: h.balance,
        pct_of_supply: totalSupply > 0 ? ((h.balance / totalSupply) * 100).toFixed(2) + "%" : "unknown",
      })),
      mint_velocity: {
        mints_per_day: mintsPerDay,
        recent_mints_sampled: nfts.length,
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

  // --- token_holders ---
  if (name === "token_holders") {
    const payment = chargeForTool("token_holders", args.api_key);
    const base = getMirrorNodeBase();
    const limit = Math.min(args.limit || 25, 100);

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    const totalSupply = parseInt(token.total_supply || 0);
    const decimals = parseInt(token.decimals || 0);

    // Fetch holders - filter zero balances and sort by balance descending client-side
    const holdersRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=${limit}&account.balance.gt=0`
    );
    const holders = (holdersRes.data.balances || [])
      .filter(h => h.balance > 0)
      .sort((a, b) => parseInt(b.balance || 0) - parseInt(a.balance || 0));

    // Concentration metrics
    const top1 = holders[0]?.balance || 0;
    const top5 = holders.slice(0, 5).reduce((sum, h) => sum + (h.balance || 0), 0);
    const top10 = holders.slice(0, 10).reduce((sum, h) => sum + (h.balance || 0), 0);

    const pct = (n) => totalSupply > 0 ? ((n / totalSupply) * 100).toFixed(2) + "%" : "unknown";

    // Whale threshold: holding >1% of supply
    const whaleThreshold = totalSupply * 0.01;
    const whaleCount = holders.filter(h => h.balance >= whaleThreshold).length;

    // Format balance with decimals
    const formatBalance = (raw) => {
      if (decimals === 0) return raw.toString();
      return (raw / Math.pow(10, decimals)).toFixed(decimals);
    };

    return {
      token_id: args.token_id,
      name: token.name,
      symbol: token.symbol,
      type: token.type,
      total_supply_raw: totalSupply,
      total_supply_formatted: formatBalance(totalSupply) + " " + token.symbol,
      decimals,
      holders_returned: holders.length,
      concentration: {
        top_1_pct: pct(top1),
        top_5_pct: pct(top5),
        top_10_pct: pct(top10),
        whale_count: whaleCount,
        whale_threshold: "holders with >1% of supply",
      },
      top_holders: holders.map(h => ({
        account: h.account,
        balance_raw: h.balance,
        balance_formatted: formatBalance(h.balance) + " " + token.symbol,
        pct_of_supply: pct(h.balance),
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown NFT tool: ${name}`);
}