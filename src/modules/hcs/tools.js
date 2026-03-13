// hcs/tools.js - HCS Topic Intelligence tool definitions and handlers
import { getTopicInfo, getTopicMessages } from "./hedera.js";
import { analyzeMessages, deepAnalyze } from "./intelligence.js";
import { chargeForTool } from "../../payments.js";

const PLATFORM_TOPIC = process.env.HCS_COMPLIANCE_TOPIC_ID || "0.0.10305125";

export const HCS_TOOL_DEFINITIONS = [
  {
    name: "hcs_monitor",
    description: "Get current status and metadata of any HCS topic - message count, creation time, memo, and recent activity. Defaults to the HederaToolbox platform topic. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "Hedera topic ID (e.g. 0.0.8026796). Defaults to the HederaIntel platform topic." },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["api_key"],
    },
  },
  {
    name: "hcs_query",
    description: "Query an HCS topic with a natural language question. Returns AI-ranked relevant messages and a plain English summary. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "Hedera topic ID (e.g. 0.0.8026796). Defaults to the HederaIntel platform topic." },
        query: { type: "string", description: "Natural language question about the topic" },
        limit: { type: "number", description: "Max messages to retrieve (default 50)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["query", "api_key"],
    },
  },
  {
    name: "hcs_understand",
    description: "Deep pattern analysis of an HCS topic - anomaly detection, trend analysis, entity extraction, or risk assessment. Costs 1.0 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "Hedera topic ID. Defaults to the HederaIntel platform topic." },
        analysis_type: {
          type: "string",
          enum: ["anomaly_detection", "trend_analysis", "entity_extraction", "risk_assessment"],
          description: "Type of analysis to perform",
        },
        lookback_days: { type: "number", description: "Days of history to analyze (default 7, max 30)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["analysis_type", "api_key"],
    },
  },
];

export async function executeHCSTool(name, args) {
  if (name === "hcs_monitor") {
    const topicId = args.topic_id || PLATFORM_TOPIC;
    const info = await getTopicInfo(topicId);
    const messages = await getTopicMessages(topicId, 5);
    return {
      topic_id: topicId,
      memo: info.memo,
      created_timestamp: info.created_timestamp,
      deleted: info.deleted,
      recent_message_count: messages.length,
      latest_message: messages[0] || null,
      network: process.env.HEDERA_NETWORK,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_query") {
    const payment = chargeForTool("hcs_query", args.api_key);
    const topicId = args.topic_id || PLATFORM_TOPIC;
    const messages = await getTopicMessages(topicId, args.limit || 50);
    const analysis = await analyzeMessages(messages, args.query);
    return {
      topic_id: topicId,
      query: args.query,
      messages_retrieved: messages.length,
      messages_relevant: analysis.relevant_messages?.length || 0,
      summary: analysis.summary,
      anomalies: analysis.anomalies,
      recommended_action: analysis.recommended_action,
      relevant_messages: analysis.relevant_messages || [],
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_understand") {
    const payment = chargeForTool("hcs_understand", args.api_key);
    const topicId = args.topic_id || PLATFORM_TOPIC;
    const messages = await getTopicMessages(topicId, 100);
    const analysis = await deepAnalyze(messages, args.analysis_type);
    return {
      topic_id: topicId,
      analysis_type: args.analysis_type,
      messages_analyzed: messages.length,
      ...analysis,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown HCS tool: ${name}`);
}