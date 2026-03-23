// compliance/tools.js - Compliance & Audit Trail tool definitions and handlers
import {
  Client,
  AccountId,
  PrivateKey,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import axios from "axios";
import crypto from "crypto";
import { chargeForTool } from "../../payments.js";

let hederaClient;

function getClient() {
  if (!hederaClient) {
    const network = process.env.HEDERA_NETWORK || "testnet";
    hederaClient = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
    hederaClient.setOperator(
      AccountId.fromString(process.env.HEDERA_ACCOUNT_ID),
      PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY)
    );
  }
  return hederaClient;
}

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

const PLATFORM_TOPIC = process.env.HCS_COMPLIANCE_TOPIC_ID || "0.0.10305125";

export const COMPLIANCE_TOOL_DEFINITIONS = [
  {
    name: "hcs_write_record",
    description: "Write tamper-evident compliance record to Hedera HCS. Returns record ID and tx proof. 5.0 HBAR.",
    annotations: { title: "Write Compliance Record", readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID to write the record to. Defaults to the HederaIntel platform topic." },
        record_type: { type: "string", description: "Type of compliance record (e.g. transaction, approval, audit_event)" },
        entity_id: { type: "string", description: "ID of the entity this record relates to" },
        data: { type: "object", description: "The compliance data to record (any JSON object)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["record_type", "entity_id", "data", "api_key"],
    },
  },
  {
    name: "hcs_verify_record",
    description: "Verify a compliance record on Hedera HCS has not been tampered. 1.0 HBAR.",
    annotations: { title: "Verify Compliance Record", readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID where the record was written. Defaults to the HederaIntel platform topic." },
        record_id: { type: "string", description: "Record ID returned when the record was written" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["record_id", "api_key"],
    },
  },
  {
    name: "hcs_audit_trail",
    description: "Full chronological audit trail for an entity from Hedera HCS. 2.0 HBAR.",
    annotations: { title: "Retrieve Audit Trail", readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "HCS topic ID to query. Defaults to the HederaIntel platform topic." },
        entity_id: { type: "string", description: "Entity ID to retrieve audit trail for" },
        limit: { type: "number", description: "Max records to retrieve (default 50)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["entity_id", "api_key"],
    },
  },
];

export async function executeComplianceTool(name, args) {
  if (name === "hcs_write_record") {
    const payment = chargeForTool("hcs_write_record", args.api_key);
    const client = getClient();
    const topicId = args.topic_id || PLATFORM_TOPIC;

    const record = {
      record_id: crypto.randomUUID(),
      record_type: args.record_type,
      entity_id: args.entity_id,
      data: args.data,
      written_at: new Date().toISOString(),
      written_by: process.env.HEDERA_ACCOUNT_ID,
    };

    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");

    record.hash = hash;

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify(record))
      .execute(client);

    const receipt = await tx.getReceipt(client);

    return {
      success: true,
      record_id: record.record_id,
      topic_id: topicId,
      entity_id: args.entity_id,
      record_type: args.record_type,
      hash,
      transaction_id: tx.transactionId.toString(),
      written_at: record.written_at,
      verification_note: "This record is permanently stored on the Hedera blockchain and cannot be altered.",
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_verify_record") {
    const payment = chargeForTool("hcs_verify_record", args.api_key);
    const base = getMirrorNodeBase();
    const topicId = args.topic_id || PLATFORM_TOPIC;

    const response = await axios.get(
      `${base}/api/v1/topics/${topicId}/messages?limit=100&order=asc`
    );

    const messages = response.data.messages || [];
    let foundRecord = null;

    for (const msg of messages) {
      try {
        const content = Buffer.from(msg.message, "base64").toString("utf-8");
        const record = JSON.parse(content);
        if (record.record_id === args.record_id) {
          const { hash, ...recordWithoutHash } = record;
          const computedHash = crypto
            .createHash("sha256")
            .update(JSON.stringify(recordWithoutHash))
            .digest("hex");

          foundRecord = {
            record_id: record.record_id,
            record_type: record.record_type,
            entity_id: record.entity_id,
            written_at: record.written_at,
            consensus_timestamp: msg.consensus_timestamp,
            hash_valid: computedHash === hash,
            tampered: computedHash !== hash,
            sequence_number: msg.sequence_number,
          };
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!foundRecord) {
      return {
        verified: false,
        record_id: args.record_id,
        topic_id: topicId,
        error: "Record not found on blockchain",
        payment,
      };
    }

    return {
      verified: true,
      tampered: foundRecord.tampered,
      hash_valid: foundRecord.hash_valid,
      topic_id: topicId,
      ...foundRecord,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  if (name === "hcs_audit_trail") {
    const payment = chargeForTool("hcs_audit_trail", args.api_key);
    const base = getMirrorNodeBase();
    const topicId = args.topic_id || PLATFORM_TOPIC;
    const limit = args.limit || 50;

    const response = await axios.get(
      `${base}/api/v1/topics/${topicId}/messages?limit=100&order=asc`
    );

    const messages = response.data.messages || [];
    const trail = [];

    for (const msg of messages) {
      try {
        const content = Buffer.from(msg.message, "base64").toString("utf-8");
        const record = JSON.parse(content);
        if (record.entity_id === args.entity_id) {
          trail.push({
            record_id: record.record_id,
            record_type: record.record_type,
            written_at: record.written_at,
            consensus_timestamp: msg.consensus_timestamp,
            sequence_number: msg.sequence_number,
            data: record.data,
          });
        }
      } catch (e) {
        continue;
      }
    }

    return {
      entity_id: args.entity_id,
      topic_id: topicId,
      total_records: trail.length,
      audit_trail: trail.slice(0, limit),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown compliance tool: ${name}`);
}