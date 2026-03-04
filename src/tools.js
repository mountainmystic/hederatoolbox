/**
 * tools.js — All 19 HederaIntel tool schemas (names + descriptions + inputSchemas only)
 *
 * This file ships inside the npm package. It contains ZERO Hedera SDK logic —
 * only the MCP tool definitions that tell AI agents what tools are available
 * and what parameters they accept.
 *
 * To add or modify a tool: edit here, bump package.json version, re-publish npm.
 * The remote server handles all logic changes independently.
 */

export const TOOLS = [

  // ─── Legal / Onboarding (always first) ────────────────────────────────────

  {
    name: "get_terms",
    description:
      "Retrieve the machine-readable Terms of Service for the HederaIntel MCP Platform. " +
      "FREE to call — no API key required. " +
      "All agents MUST call this tool and then call confirm_terms before using any paid tool. " +
      "Returns full legal JSON: pricing tiers, HITL thresholds, liability disclaimers, and consent instructions.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  {
    name: "confirm_terms",
    description:
      "Confirm acceptance of the HederaIntel Terms of Service. " +
      "Must be called before any paid tool will execute. " +
      "Records a timestamped consent event server-side. FREE to call — no HBAR charged.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your Hedera account ID / API key (e.g. 0.0.456789)",
        },
        terms_version: {
          type: "string",
          description: "The terms version you are accepting — must match the version returned by get_terms.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true to record consent.",
        },
      },
      required: ["api_key", "terms_version", "confirmed"],
    },
  },

  // ─── Account ──────────────────────────────────────────────────────────────

  {
    name: "account_info",
    description:
      "Get platform wallet address, pricing for all tools, and your current balance. " +
      "FREE to call — no API key required. Use this tool first to discover how to fund " +
      "an account and start using the platform. To create an account automatically, " +
      "simply send HBAR to the platform wallet — your Hedera account ID becomes your " +
      "API key within 30 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description:
            "Optional. Your Hedera account ID (e.g. 0.0.456789) or API key. " +
            "If provided, your current balance is returned.",
        },
      },
      required: [],
    },
  },

  // ─── HCS ──────────────────────────────────────────────────────────────────

  {
    name: "hcs_monitor",
    description:
      "Get current status and metadata of any HCS topic - message count, creation time, " +
      "memo, and recent activity. Defaults to the HederaIntel platform topic. Costs 0.05 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        topic_id: {
          type: "string",
          description:
            "Hedera topic ID (e.g. 0.0.8026796). Defaults to the HederaIntel platform topic.",
        },
      },
      required: ["api_key"],
    },
  },

  {
    name: "hcs_query",
    description:
      "Query an HCS topic with a natural language question. Returns AI-ranked relevant " +
      "messages and a plain English summary. Costs 0.05 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        query: { type: "string", description: "Natural language question about the topic" },
        topic_id: {
          type: "string",
          description:
            "Hedera topic ID (e.g. 0.0.8026796). Defaults to the HederaIntel platform topic.",
        },
        limit: { type: "number", description: "Max messages to retrieve (default 50)" },
      },
      required: ["api_key", "query"],
    },
  },

  {
    name: "hcs_understand",
    description:
      "Deep pattern analysis of an HCS topic - anomaly detection, trend analysis, " +
      "entity extraction, or risk assessment. Costs 0.50 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        analysis_type: {
          type: "string",
          enum: ["anomaly_detection", "trend_analysis", "entity_extraction", "risk_assessment"],
          description: "Type of analysis to perform",
        },
        topic_id: {
          type: "string",
          description: "Hedera topic ID. Defaults to the HederaIntel platform topic.",
        },
        lookback_days: {
          type: "number",
          description: "Days of history to analyze (default 7, max 30)",
        },
      },
      required: ["api_key", "analysis_type"],
    },
  },

  // ─── Compliance ───────────────────────────────────────────────────────────

  {
    name: "hcs_write_record",
    description:
      "Write a tamper-evident compliance record to the Hedera blockchain. Returns a " +
      "record ID and transaction proof. If no topic_id is provided, writes to the shared " +
      "HederaIntel platform topic. Costs 2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        record_type: {
          type: "string",
          description: "Type of compliance record (e.g. transaction, approval, audit_event)",
        },
        entity_id: { type: "string", description: "ID of the entity this record relates to" },
        data: { type: "object", description: "The compliance data to record (any JSON object)" },
        topic_id: {
          type: "string",
          description:
            "HCS topic ID to write the record to. Defaults to the HederaIntel platform topic.",
        },
      },
      required: ["api_key", "record_type", "entity_id", "data"],
    },
  },

  {
    name: "hcs_verify_record",
    description:
      "Verify a compliance record exists on the Hedera blockchain and has not been " +
      "tampered with. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        record_id: {
          type: "string",
          description: "Record ID returned when the record was written",
        },
        topic_id: {
          type: "string",
          description:
            "HCS topic ID where the record was written. Defaults to the HederaIntel platform topic.",
        },
      },
      required: ["api_key", "record_id"],
    },
  },

  {
    name: "hcs_audit_trail",
    description:
      "Retrieve the full chronological audit trail for an entity from the Hedera " +
      "blockchain. Costs 1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        entity_id: { type: "string", description: "Entity ID to retrieve audit trail for" },
        topic_id: {
          type: "string",
          description:
            "HCS topic ID to query. Defaults to the HederaIntel platform topic.",
        },
        limit: { type: "number", description: "Max records to retrieve (default 50)" },
      },
      required: ["api_key", "entity_id"],
    },
  },

  // ─── Governance ───────────────────────────────────────────────────────────

  {
    name: "governance_monitor",
    description:
      "Monitor active governance proposals for a Hedera token or DAO. Returns open " +
      "proposals, voting deadlines, and current vote tallies. Provide topic_id for best " +
      "results — without it, only token metadata is returned. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        token_id: {
          type: "string",
          description: "Hedera token ID to monitor governance for (e.g. 0.0.123456)",
        },
        topic_id: {
          type: "string",
          description: "Optional HCS topic ID used for governance messages",
        },
      },
      required: ["api_key", "token_id"],
    },
  },

  {
    name: "governance_analyze",
    description:
      "Deep analysis of a governance proposal including voter sentiment, participation " +
      "rate, token concentration, and outcome prediction. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        token_id: {
          type: "string",
          description: "Hedera token ID the proposal belongs to",
        },
        proposal_id: {
          type: "string",
          description: "Proposal ID or HCS sequence number to analyze",
        },
        topic_id: {
          type: "string",
          description: "HCS topic ID where proposal votes are recorded",
        },
      },
      required: ["api_key", "proposal_id", "token_id"],
    },
  },

  // ─── Token ────────────────────────────────────────────────────────────────

  {
    name: "token_price",
    description:
      "Get the current price, market cap, and 24h trading volume for a Hedera token. " +
      "Costs 0.05 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        token_id: { type: "string", description: "Hedera token ID (e.g. 0.0.123456)" },
      },
      required: ["api_key", "token_id"],
    },
  },

  {
    name: "token_analyze",
    description:
      "Deep analysis of a Hedera token including holder distribution, transfer velocity, " +
      "liquidity, and risk scoring. Costs 0.3 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        token_id: {
          type: "string",
          description: "Hedera token ID to analyze (e.g. 0.0.123456)",
        },
      },
      required: ["api_key", "token_id"],
    },
  },

  {
    name: "token_monitor",
    description:
      "Monitor recent token transfer activity, whale movements, and unusual trading " +
      "patterns for a Hedera token. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        token_id: {
          type: "string",
          description: "Hedera token ID to monitor (e.g. 0.0.123456)",
        },
        limit: {
          type: "number",
          description: "Number of recent transactions to return (default 25, max 100)",
        },
      },
      required: ["api_key", "token_id"],
    },
  },

  // ─── Identity ─────────────────────────────────────────────────────────────

  {
    name: "identity_resolve",
    description:
      "Resolve a Hedera account ID to its on-chain identity profile including account " +
      "age, token holdings, transaction history, and any HCS-based identity records. " +
      "Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        account_id: {
          type: "string",
          description: "Hedera account ID to resolve (e.g. 0.0.123456)",
        },
      },
      required: ["api_key", "account_id"],
    },
  },

  {
    name: "identity_verify_kyc",
    description:
      "Check the KYC status of a Hedera account for one or more tokens. Returns KYC " +
      "grant status and verification history. Costs 0.2 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        account_id: {
          type: "string",
          description: "Hedera account ID to check KYC for",
        },
        token_id: {
          type: "string",
          description: "Optional token ID to check KYC status for a specific token",
        },
      },
      required: ["api_key", "account_id"],
    },
  },

  {
    name: "identity_check_sanctions",
    description:
      "Screen a Hedera account against on-chain risk signals including transaction " +
      "patterns, counterparty risk, and known flagged accounts. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        account_id: { type: "string", description: "Hedera account ID to screen" },
      },
      required: ["api_key", "account_id"],
    },
  },

  // ─── Contract ─────────────────────────────────────────────────────────────

  {
    name: "contract_read",
    description:
      "Read state from a Hedera smart contract - get contract info, bytecode size, " +
      "recent activity, and storage details without executing a transaction. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        contract_id: {
          type: "string",
          description: "Hedera contract ID (e.g. 0.0.123456) or EVM address (0x...)",
        },
      },
      required: ["api_key", "contract_id"],
    },
  },

  {
    name: "contract_call",
    description:
      "Execute a read-only call to a Hedera smart contract function and return the " +
      "result. Does not submit a transaction or cost gas. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        contract_id: {
          type: "string",
          description: "Hedera contract ID (e.g. 0.0.123456) or EVM address (0x...)",
        },
        function_name: {
          type: "string",
          description:
            "Contract function name to call (e.g. balanceOf, totalSupply, name)",
        },
        function_params: {
          type: "array",
          items: { type: "string" },
          description: "Optional array of parameter values to pass to the function",
        },
        abi_hint: {
          type: "string",
          description: "Optional ABI hint - common values: ERC20, ERC721, HTS",
        },
      },
      required: ["api_key", "contract_id", "function_name"],
    },
  },

  {
    name: "contract_analyze",
    description:
      "Deep analysis of a Hedera smart contract including activity patterns, caller " +
      "distribution, gas usage, risk assessment, and functional classification. Costs 1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your HederaIntel API key" },
        contract_id: {
          type: "string",
          description: "Hedera contract ID to analyze (e.g. 0.0.123456)",
        },
      },
      required: ["api_key", "contract_id"],
    },
  },

];
