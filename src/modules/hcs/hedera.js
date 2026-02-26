// hcs/hedera.js - Hedera mirror node integration
import axios from "axios";

function getMirrorNodeBase() {
  const network = process.env.HEDERA_NETWORK || "testnet";
  return network === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export async function getTopicInfo(topicId) {
  const base = getMirrorNodeBase();
  const response = await axios.get(`${base}/api/v1/topics/${topicId}`);
  return response.data;
}

export async function getTopicMessages(topicId, limit = 50, since = null) {
  const base = getMirrorNodeBase();
  let url = `${base}/api/v1/topics/${topicId}/messages?limit=${limit}&order=desc`;
  if (since) url += `&timestamp=gte:${since}`;
  const response = await axios.get(url);
  const messages = response.data.messages || [];
  return messages.map((msg) => ({
    sequence_number: msg.sequence_number,
    consensus_timestamp: msg.consensus_timestamp,
    content: Buffer.from(msg.message, "base64").toString("utf-8"),
    payer_account_id: msg.payer_account_id,
  }));
}