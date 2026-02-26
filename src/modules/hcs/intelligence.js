// hcs/intelligence.js - GPT-4o Mini analysis engine
import OpenAI from "openai";

let openai;

function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export async function analyzeMessages(messages, query) {
  const client = getOpenAI();
  const messagesText = messages
    .map((m) => `[${m.sequence_number}] ${m.content}`)
    .join("\n");

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an AI analyst for Hedera blockchain data.
Analyze HCS topic messages and answer the user query.
Respond with JSON: { summary, anomalies, recommended_action, relevant_messages: [{sequence_number, content, relevance_score}] }
relevance_score is 0.0-1.0. Only include messages with score > 0.5.`,
      },
      {
        role: "user",
        content: `Query: ${query}\n\nMessages:\n${messagesText}`,
      },
    ],
    max_tokens: 1000,
  });

  return JSON.parse(response.choices[0].message.content);
}

export async function deepAnalyze(messages, analysisType) {
  const client = getOpenAI();
  const messagesText = messages
    .map((m) => `[${m.sequence_number}] ${m.content}`)
    .join("\n");

  const prompts = {
    anomaly_detection: "Detect unusual patterns, outliers, or suspicious activity.",
    trend_analysis: "Identify trends, patterns, and changes over time.",
    entity_extraction: "Extract key entities, actors, and relationships.",
    risk_assessment: "Assess risks, vulnerabilities, and concerns.",
  };

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a deep analyst for Hedera blockchain data.
${prompts[analysisType]}
Respond with JSON: { executive_summary, findings: [], risk_level, recommendations: [] }`,
      },
      {
        role: "user",
        content: `Analyze these HCS messages:\n${messagesText}`,
      },
    ],
    max_tokens: 1500,
  });

  return JSON.parse(response.choices[0].message.content);
}