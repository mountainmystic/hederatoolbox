// governance/tools.js - Governance Intelligence tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";
import { enforceHITL } from "../../hitl.js";

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export const GOVERNANCE_TOOL_DEFINITIONS = [
  {
    name: "governance_monitor",
    description: "Monitor active governance proposals for a Hedera token or DAO. Returns open proposals, voting deadlines, and current vote tallies. Provide topic_id for best results — without it, only token metadata is returned. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID to monitor governance for (e.g. 0.0.123456)" },
        topic_id: { type: "string", description: "Optional HCS topic ID used for governance messages" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "api_key"],
    },
  },
  {
    name: "governance_analyze",
    description: "Deep analysis of a governance proposal including voter sentiment, participation rate, token concentration, and outcome prediction. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        token_id: { type: "string", description: "Hedera token ID the proposal belongs to" },
        proposal_id: { type: "string", description: "Proposal ID or HCS sequence number to analyze" },
        topic_id: { type: "string", description: "HCS topic ID where proposal votes are recorded" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["token_id", "proposal_id", "api_key"],
    },
  },
  {
    name: "governance_vote",
    description: "Cast a governance vote on-chain via HCS, permanently recording your vote for a proposal. REQUIRES HUMAN APPROVAL — this is an irreversible on-chain write. First call without approval_token to get the approval URL. After a human approves at that URL, retry with the approval_token to cast the vote. Costs 2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID where votes are recorded" },
        proposal_id: { type: "string", description: "The proposal ID you are voting on" },
        vote: { type: "string", description: "Your vote: 'yes', 'no', or 'abstain'" },
        voter_id: { type: "string", description: "Your Hedera account ID (e.g. 0.0.123456)" },
        rationale: { type: "string", description: "Optional short rationale for your vote" },
        approval_token: { type: "string", description: "Approval token returned after human approves the vote at the approval URL" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["topic_id", "proposal_id", "vote", "voter_id", "api_key"],
    },
  },
];

export async function executeGovernanceTool(name, args) {

  // --- governance_monitor ---
  if (name === "governance_monitor") {
    const payment = chargeForTool("governance_monitor", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    // Fetch HCS messages if topic_id provided (look for governance messages)
    let proposals = [];
    if (args.topic_id) {
      const msgRes = await axios.get(
        `${base}/api/v1/topics/${args.topic_id}/messages?limit=100&order=desc`
      );
      const messages = msgRes.data.messages || [];
      for (const msg of messages) {
        try {
          const content = Buffer.from(msg.message, "base64").toString("utf-8");
          const parsed = JSON.parse(content);
          if (parsed.type === "proposal" || parsed.proposal_id) {
            proposals.push({
              proposal_id: parsed.proposal_id || msg.sequence_number,
              title: parsed.title || "Untitled Proposal",
              status: parsed.status || "active",
              created_at: msg.consensus_timestamp,
              deadline: parsed.deadline || null,
              yes_votes: parsed.yes_votes || 0,
              no_votes: parsed.no_votes || 0,
              abstain_votes: parsed.abstain_votes || 0,
            });
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Fetch recent token transactions as proxy for governance activity
    const txRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/nfts?limit=5`
    ).catch(() => ({ data: {} }));

    const holderRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=10&order=desc`
    ).catch(() => ({ data: { balances: [] } }));

    const topHolders = (holderRes.data.balances || []).slice(0, 5).map(b => ({
      account: b.account,
      balance: b.balance,
    }));

    return {
      token_id: args.token_id,
      token_name: token.name || "Unknown",
      token_symbol: token.symbol || "?",
      total_supply: token.total_supply,
      treasury: token.treasury_account_id,
      governance_topic: args.topic_id || null,
      active_proposals: proposals.filter(p => p.status !== "closed").length,
      proposals,
      top_holders: topHolders,
      summary: proposals.length === 0
        ? "No governance proposals found on this topic. The token may use off-chain voting or no topic_id was provided."
        : `Found ${proposals.length} proposal(s). Pass a proposal_id to governance_analyze for deep analysis.`,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- governance_analyze ---
  if (name === "governance_analyze") {
    const payment = chargeForTool("governance_analyze", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch token info
    const tokenRes = await axios.get(`${base}/api/v1/tokens/${args.token_id}`);
    const token = tokenRes.data;

    // Fetch all votes for this proposal from HCS topic if provided
    let votes = { yes: 0, no: 0, abstain: 0, total: 0, voters: [] };
    let proposalDetails = null;

    if (args.topic_id) {
      const msgRes = await axios.get(
        `${base}/api/v1/topics/${args.topic_id}/messages?limit=100&order=asc`
      );
      const messages = msgRes.data.messages || [];

      for (const msg of messages) {
        try {
          const content = Buffer.from(msg.message, "base64").toString("utf-8");
          const parsed = JSON.parse(content);

          // Find the original proposal
          if (
            (parsed.type === "proposal" || parsed.proposal_id) &&
            String(parsed.proposal_id || msg.sequence_number) === String(args.proposal_id)
          ) {
            proposalDetails = {
              title: parsed.title || "Untitled Proposal",
              description: parsed.description || "No description provided.",
              created_at: msg.consensus_timestamp,
              deadline: parsed.deadline || null,
              proposer: parsed.proposer || null,
            };
          }

          // Tally votes for this proposal
          if (parsed.type === "vote" && String(parsed.proposal_id) === String(args.proposal_id)) {
            const v = (parsed.vote || "").toLowerCase();
            if (v === "yes") votes.yes++;
            else if (v === "no") votes.no++;
            else votes.abstain++;
            votes.total++;
            votes.voters.push({ voter: parsed.voter_id, vote: v, timestamp: msg.consensus_timestamp });
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Token holder concentration
    const holderRes = await axios.get(
      `${base}/api/v1/tokens/${args.token_id}/balances?limit=20&order=desc`
    ).catch(() => ({ data: { balances: [] } }));

    const holders = holderRes.data.balances || [];
    const totalSupply = parseInt(token.total_supply || 0);
    const top5Balance = holders.slice(0, 5).reduce((s, b) => s + parseInt(b.balance || 0), 0);
    const concentrationPct = totalSupply > 0 ? ((top5Balance / totalSupply) * 100).toFixed(1) : "unknown";

    // Participation rate
    const participationRate = votes.total > 0 && holders.length > 0
      ? ((votes.total / holders.length) * 100).toFixed(1) + "%"
      : "unknown";

    // Simple outcome prediction
    let prediction = "Insufficient votes to predict outcome.";
    if (votes.total > 0) {
      const yesPct = (votes.yes / votes.total) * 100;
      const noPct = (votes.no / votes.total) * 100;
      if (yesPct > 60) prediction = "Likely to PASS - strong yes majority.";
      else if (noPct > 60) prediction = "Likely to FAIL - strong no majority.";
      else if (yesPct > noPct) prediction = "Leaning YES but outcome uncertain.";
      else if (noPct > yesPct) prediction = "Leaning NO but outcome uncertain.";
      else prediction = "Tied - outcome is uncertain.";
    }

    return {
      proposal_id: args.proposal_id,
      token_id: args.token_id,
      token_name: token.name || "Unknown",
      proposal: proposalDetails || { note: "Proposal details not found in topic. It may use off-chain governance." },
      vote_tally: {
        yes: votes.yes,
        no: votes.no,
        abstain: votes.abstain,
        total: votes.total,
        yes_pct: votes.total > 0 ? ((votes.yes / votes.total) * 100).toFixed(1) + "%" : "0%",
        no_pct: votes.total > 0 ? ((votes.no / votes.total) * 100).toFixed(1) + "%" : "0%",
      },
      participation_rate: participationRate,
      token_concentration: {
        top_5_holders_pct: concentrationPct + "%",
        note: concentrationPct > 50
          ? "High concentration - top 5 holders control majority of supply."
          : "Reasonably distributed token supply.",
      },
      outcome_prediction: prediction,
      recent_voters: votes.voters.slice(-10),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- governance_vote ---
  if (name === "governance_vote") {
    // HITL hard stop — if no approval_token, block and return approval URL
    // If approval_token provided, verify it's approved before proceeding
    if (!args.approval_token) {
      const hitl = await enforceHITL("governance_vote", args.api_key, "2.0000");
      if (!hitl.proceed) throw new Error(hitl.error);
    } else {
      const { checkApproval } = await import("../../hitl.js");
      const check = checkApproval(args.approval_token);
      if (!check.approved) {
        throw new Error(
          `Approval token "${args.approval_token}" is not yet approved. ` +
          `A human operator must visit the approval URL first.`
        );
      }
    }

    const payment = chargeForTool("governance_vote", args.api_key);

    const validVotes = ["yes", "no", "abstain"];
    const vote = (args.vote || "").toLowerCase();
    if (!validVotes.includes(vote)) {
      throw new Error("Invalid vote value. Must be 'yes', 'no', or 'abstain'.");
    }

    // Import Hedera SDK for on-chain write
    const { Client, AccountId, PrivateKey, TopicMessageSubmitTransaction } = await import("@hashgraph/sdk");

    const network = process.env.HEDERA_NETWORK || "testnet";
    const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
      PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY)
    );

    const voteRecord = {
      type: "vote",
      proposal_id: args.proposal_id,
      voter_id: args.voter_id,
      vote: vote,
      rationale: args.rationale || null,
      cast_at: new Date().toISOString(),
    };

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(args.topic_id)
      .setMessage(JSON.stringify(voteRecord))
      .execute(client);

    const receipt = await tx.getReceipt(client);

    return {
      success: true,
      proposal_id: args.proposal_id,
      topic_id: args.topic_id,
      voter_id: args.voter_id,
      vote: vote,
      rationale: args.rationale || null,
      transaction_id: tx.transactionId.toString(),
      cast_at: voteRecord.cast_at,
      note: "Your vote has been permanently recorded on the Hedera blockchain and cannot be altered.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown governance tool: ${name}`);
}