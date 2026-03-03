// contract/tools.js - Smart Contract Abstraction tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";
// ---------------------------------------------------------------------------
// ABI encoding helpers — pure JS, no extra dependencies
// ---------------------------------------------------------------------------

// Minimal keccak256 using js-sha3 (transitive dep via @hashgraph/sdk)
// We import ethers which is bundled with @hashgraph/sdk
import { ethers } from "ethers";

function buildSelector(signature) {
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature));
  return hash.slice(0, 10); // 0x + 8 hex chars = 4 bytes
}

// ABI-encode a single value into a 32-byte hex slot (no 0x prefix)
function encodeParam(value) {
  // address
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value.slice(2).toLowerCase().padStart(64, "0");
  }
  // Hedera ID -> convert to EVM address (0x + zero-padded account number)
  if (typeof value === "string" && /^\d+\.\d+\.(\d+)$/.test(value)) {
    const parts = value.split(".");
    const num = parseInt(parts[2], 10);
    return num.toString(16).padStart(64, "0");
  }
  // boolean
  if (value === "true" || value === true) return "1".padStart(64, "0");
  if (value === "false" || value === false) return "0".padStart(64, "0");
  // hex bytes32
  if (typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    return value.slice(2).padStart(64, "0");
  }
  // uint256 / plain number or numeric string
  const num = BigInt(value);
  return num.toString(16).padStart(64, "0");
}

// Build full calldata: selector + encoded params
function buildCalldata(functionSignature, params = []) {
  const selector = buildSelector(functionSignature);
  if (!params || params.length === 0) return selector;
  const encoded = params.map(encodeParam).join("");
  return selector + encoded;
}

// Infer the most likely full function signature from name + params
// e.g. "balanceOf" + ["0x1234..."] -> "balanceOf(address)"
function inferSignature(functionName, params = []) {
  if (!params || params.length === 0) return `${functionName}()`;

  const types = params.map(p => {
    if (typeof p === "string" && /^0x[0-9a-fA-F]{40}$/.test(p)) return "address";
    if (typeof p === "string" && /^\d+\.\d+\.\d+$/.test(p)) return "address"; // Hedera ID
    if (p === "true" || p === "false") return "bool";
    if (typeof p === "string" && /^0x[0-9a-fA-F]{64}$/.test(p)) return "bytes32";
    if (typeof p === "string" && /^\d+$/.test(p)) return "uint256";
    return "uint256"; // safe fallback
  });
  return `${functionName}(${types.join(",")})`;
}

// Decode a 32-byte hex slot into human-readable candidates
function decodeSlot(hex) {
  const clean = hex.replace("0x", "").padStart(64, "0");
  const candidates = {};
  // uint256
  try { candidates.as_uint256 = BigInt("0x" + clean).toString(); } catch {}
  // address (last 20 bytes)
  candidates.as_address = "0x" + clean.slice(24);
  // bool
  candidates.as_bool = clean === "0".repeat(63) + "1" ? true
    : clean === "0".repeat(64) ? false : null;
  return candidates;
}

// Decode ABI result: handles single slot, string, and uint256 returns
function decodeResult(hex) {
  const raw = hex.replace("0x", "");
  if (raw.length === 0) return { raw_hex: hex, note: "Empty response" };

  // Single 32-byte slot
  if (raw.length === 64) {
    return { raw_hex: hex, ...decodeSlot(raw), note: "Single 32-byte slot decoded" };
  }

  // Dynamic type (string/bytes): offset(32) + length(32) + data
  if (raw.length >= 128) {
    try {
      const lengthHex = raw.slice(64, 128);
      const length = parseInt(lengthHex, 16);
      if (length > 0 && length <= 256) {
        const dataHex = raw.slice(128, 128 + length * 2);
        const bytes = [];
        for (let i = 0; i < dataHex.length; i += 2) {
          bytes.push(parseInt(dataHex.substr(i, 2), 16));
        }
        const str = String.fromCharCode(...bytes).replace(/\0/g, "").trim();
        if (str && /^[\x20-\x7E]+$/.test(str)) {
          return { raw_hex: hex, as_string: str, note: "Decoded as ABI string" };
        }
      }
    } catch {}
  }

  // Multiple 32-byte slots — decode each
  const slots = [];
  for (let i = 0; i < raw.length; i += 64) {
    const slot = raw.slice(i, i + 64);
    if (slot.length === 64) slots.push(decodeSlot(slot));
  }
  return { raw_hex: hex, slots, note: `${slots.length} slot(s) decoded` };
}

function getMirrorNodeBase() {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export const CONTRACT_TOOL_DEFINITIONS = [
  {
    name: "contract_read",
    description: "Read state from a Hedera smart contract - get contract info, bytecode size, recent activity, and storage details without executing a transaction. Costs 0.1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: { type: "string", description: "Hedera contract ID (e.g. 0.0.123456) or EVM address (0x...)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["contract_id", "api_key"],
    },
  },
  {
    name: "contract_call",
    description: "Execute a read-only call to a Hedera smart contract function and return the result. Does not submit a transaction or cost gas. Costs 0.5 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: { type: "string", description: "Hedera contract ID (e.g. 0.0.123456) or EVM address (0x...)" },
        function_name: { type: "string", description: "Contract function name to call (e.g. balanceOf, totalSupply, name)" },
        function_params: { type: "array", description: "Optional array of parameter values to pass to the function", items: { type: "string" } },
        abi_hint: { type: "string", description: "Optional ABI hint - common values: ERC20, ERC721, HTS" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["contract_id", "function_name", "api_key"],
    },
  },
  {
    name: "contract_analyze",
    description: "Deep analysis of a Hedera smart contract including activity patterns, caller distribution, gas usage, risk assessment, and functional classification. Costs 1 HBAR.",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: { type: "string", description: "Hedera contract ID to analyze (e.g. 0.0.123456)" },
        api_key: { type: "string", description: "Your HederaIntel API key" },
      },
      required: ["contract_id", "api_key"],
    },
  },
];

export async function executeContractTool(name, args) {

  // --- contract_read ---
  if (name === "contract_read") {
    const payment = chargeForTool("contract_read", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch contract info
    const contractRes = await axios.get(`${base}/api/v1/contracts/${args.contract_id}`);
    const contract = contractRes.data;

    // Fetch recent contract results (calls)
    const resultsRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/results?limit=10&order=desc`
    ).catch(() => ({ data: { results: [] } }));
    const results = resultsRes.data.results || [];

    // Fetch contract state entries count
    const stateRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/state?limit=25`
    ).catch(() => ({ data: { state: [] } }));
    const stateEntries = stateRes.data.state || [];

    // Calculate contract age
    const createdAt = contract.created_timestamp
      ? new Date(parseFloat(contract.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Recent callers
    const callers = [...new Set(results.map(r => r.from).filter(Boolean))];

    // Gas usage stats
    const gasUsed = results.map(r => parseInt(r.gas_used || 0));
    const avgGas = gasUsed.length > 0
      ? Math.round(gasUsed.reduce((a, b) => a + b, 0) / gasUsed.length)
      : null;
    const maxGas = gasUsed.length > 0 ? Math.max(...gasUsed) : null;

    return {
      contract_id: args.contract_id,
      evm_address: contract.evm_address || null,
      admin_key: contract.admin_key ? true : false,
      auto_renew_account: contract.auto_renew_account_id || null,
      auto_renew_period: contract.auto_renew_period || null,
      created_at: createdAt ? createdAt.toISOString() : null,
      age_days: ageDays,
      expiration_timestamp: contract.expiration_timestamp || null,
      memo: contract.memo || null,
      obtainer_account: contract.obtainer_account_id || null,
      proxy_account: contract.proxy_account_id || null,
      bytecode_size_bytes: contract.bytecode ? Math.round(contract.bytecode.length / 2) : null,
      file_id: contract.file_id || null,
      max_automatic_token_associations: contract.max_automatic_token_associations || 0,
      hbar_balance: contract.balance?.balance
        ? (contract.balance.balance / 100000000).toFixed(4) + " HBAR"
        : "0.0000 HBAR",
      recent_call_count: results.length,
      recent_callers: callers.slice(0, 5),
      gas_stats: {
        avg_gas_used: avgGas,
        max_gas_used: maxGas,
      },
      state_entry_count: stateEntries.length,
      deleted: contract.deleted || false,
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- contract_call ---
  if (name === "contract_call") {
    const payment = chargeForTool("contract_call", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch contract info
    const contractRes = await axios.get(`${base}/api/v1/contracts/${args.contract_id}`)
      .catch(() => ({ data: {} }));
    const contract = contractRes.data;
    const evmTarget = contract.evm_address || args.contract_id;

    const funcName = args.function_name;
    const params = args.function_params || [];

    // Build signature: use explicit abi_hint signature if provided (e.g. "balanceOf(address)")
    // Otherwise infer from function name and param types
    let signature;
    if (args.abi_hint && args.abi_hint.includes("(")) {
      // User passed a full signature as abi_hint e.g. "balanceOf(address)"
      signature = args.abi_hint;
    } else {
      signature = inferSignature(funcName, params);
    }

    const calldata = buildCalldata(signature, params);
    const selectorUsed = calldata.slice(0, 10);

    // Execute via mirror node eth_call
    let callResult = null;
    let callError = null;
    try {
      const callRes = await axios.post(
        `${base}/api/v1/contracts/call`,
        {
          data: calldata,
          to: evmTarget,
          gas: 400000,
          gasPrice: 0,
          estimate: false,
        }
      );
      callResult = callRes.data;
    } catch (e) {
      callError = e.response?.data?._status?.messages?.[0]?.message
        || e.response?.data?.detail
        || e.response?.data?.message
        || JSON.stringify(e.response?.data)
        || e.message;
    }

    // Decode the result
    let decoded = null;
    if (callResult?.result && callResult.result !== "0x") {
      decoded = decodeResult(callResult.result);
    }

    // Recent call history
    const resultsRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/results?limit=10&order=desc`
    ).catch(() => ({ data: { results: [] } }));
    const results = resultsRes.data.results || [];

    return {
      contract_id: args.contract_id,
      evm_address: contract.evm_address || null,
      function_called: funcName,
      signature_used: signature,
      selector_used: selectorUsed,
      params_encoded: params,
      calldata_sent: calldata,
      call_result: decoded,
      call_error: callError,
      note: callError
        ? "Call failed — check signature or params. You can pass a full ABI signature as abi_hint e.g. 'balanceOf(address)'."
        : decoded
        ? "Call succeeded."
        : "Call returned empty result — function may have no return value or is write-only.",
      recent_call_history: results.slice(0, 5).map(r => ({
        timestamp: r.timestamp,
        from: r.from,
        gas_used: r.gas_used,
        status: r.status,
      })),
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  // --- contract_analyze ---
  if (name === "contract_analyze") {
    const payment = chargeForTool("contract_analyze", args.api_key);
    const base = getMirrorNodeBase();

    // Fetch contract info
    const contractRes = await axios.get(`${base}/api/v1/contracts/${args.contract_id}`);
    const contract = contractRes.data;

    // Fetch recent results (up to 100)
    const resultsRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/results?limit=100&order=desc`
    ).catch(() => ({ data: { results: [] } }));
    const results = resultsRes.data.results || [];

    // Fetch contract logs
    const logsRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/results/logs?limit=50&order=desc`
    ).catch(() => ({ data: { logs: [] } }));
    const logs = logsRes.data.logs || [];

    // Fetch state
    const stateRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/state?limit=25`
    ).catch(() => ({ data: { state: [] } }));
    const stateEntries = stateRes.data.state || [];

    // Contract age
    const createdAt = contract.created_timestamp
      ? new Date(parseFloat(contract.created_timestamp) * 1000)
      : null;
    const ageDays = createdAt
      ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Caller analysis
    const callerCounts = {};
    for (const r of results) {
      if (r.from) callerCounts[r.from] = (callerCounts[r.from] || 0) + 1;
    }
    const topCallers = Object.entries(callerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([account, count]) => ({ account, call_count: count }));

    // Gas analysis
    const gasUsed = results.map(r => parseInt(r.gas_used || 0)).filter(g => g > 0);
    const avgGas = gasUsed.length > 0
      ? Math.round(gasUsed.reduce((a, b) => a + b, 0) / gasUsed.length)
      : 0;
    const maxGas = gasUsed.length > 0 ? Math.max(...gasUsed) : 0;
    const minGas = gasUsed.length > 0 ? Math.min(...gasUsed) : 0;

    // Success/failure rate
    // Mirror node contract results: status field is "0x1" (success) or "0x0" (fail)
    // result field may contain revert reason strings for failures
    const successCount = results.filter(r =>
      r.status === "0x1" || r.result === "SUCCESS" || (!r.status && !r.error_message)
    ).length;
    const failCount = results.filter(r =>
      r.status === "0x0" || (r.error_message && r.error_message.length > 0)
    ).length;

    // Activity trend - group by day
    const dayActivity = {};
    for (const r of results) {
      if (r.timestamp) {
        const day = new Date(parseFloat(r.timestamp) * 1000).toISOString().slice(0, 10);
        dayActivity[day] = (dayActivity[day] || 0) + 1;
      }
    }
    const activityByDay = Object.entries(dayActivity)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .map(([date, count]) => ({ date, calls: count }));

    // Function signature analysis from call data
    const functionCalls = {};
    for (const r of results) {
      if (r.function_parameters && r.function_parameters.length >= 10) {
        const sig = r.function_parameters.slice(0, 10);
        functionCalls[sig] = (functionCalls[sig] || 0) + 1;
      }
    }
    const topFunctions = Object.entries(functionCalls)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([selector, count]) => ({ selector, call_count: count }));

    // Risk assessment
    const riskSignals = [];
    let riskScore = 0;

    if (!contract.admin_key) { riskSignals.push("No admin key - contract is immutable (good for decentralization)"); }
    if (contract.deleted) { riskScore += 50; riskSignals.push("Contract has been DELETED"); }
    if (failCount > 0 && failCount > successCount && results.length > 5) { riskScore += 20; riskSignals.push("High failure rate - more failed calls than successful ones"); }
    if (ageDays !== null && ageDays < 7) { riskScore += 15; riskSignals.push("Very new contract - deployed less than 7 days ago"); }
    if (topCallers.length === 1 && results.length > 10) { riskScore += 10; riskSignals.push("Single caller dominates all interactions"); }
    if (stateEntries.length === 0 && results.length > 0) { riskSignals.push("No readable state entries - contract may use non-standard storage"); }
    if (riskSignals.length === 0) riskSignals.push("No significant risk signals detected");

    const riskLevel = riskScore >= 40 ? "HIGH" : riskScore >= 15 ? "MEDIUM" : "LOW";

    // Contract classification guess
    let classification = "Unknown";
    const logTopics = logs.map(l => (l.topics || [])[0]).filter(Boolean);
    const uniqueTopics = [...new Set(logTopics)];
    if (uniqueTopics.some(t => t.startsWith("0xddf252ad"))) classification = "ERC20 / HTS Token";
    else if (uniqueTopics.some(t => t.startsWith("0xc3d58168"))) classification = "ERC1155 Multi-Token";
    else if (uniqueTopics.some(t => t.startsWith("0x17307eab"))) classification = "ERC721 NFT";
    else if (results.length > 50) classification = "High-activity contract (DEX, lending, or staking likely)";
    else if (results.length > 0) classification = "General purpose smart contract";

    return {
      contract_id: args.contract_id,
      evm_address: contract.evm_address || null,
      created_at: createdAt ? createdAt.toISOString() : null,
      age_days: ageDays,
      deleted: contract.deleted || false,
      hbar_balance: contract.balance?.balance
        ? (contract.balance.balance / 100000000).toFixed(4) + " HBAR"
        : "0.0000 HBAR",
      classification,
      activity: {
        total_calls_sampled: results.length,
        successful_calls: successCount,
        failed_calls: failCount,
        success_rate: results.length > 0 ? ((successCount / results.length) * 100).toFixed(1) + "%" : "unknown",
        unique_callers: Object.keys(callerCounts).length,
        recent_logs: logs.length,
        state_entries: stateEntries.length,
      },
      gas_analysis: {
        avg_gas_used: avgGas,
        max_gas_used: maxGas,
        min_gas_used: minGas,
      },
      top_callers: topCallers,
      top_function_selectors: topFunctions,
      activity_last_7_days: activityByDay,
      risk_assessment: {
        score: riskScore,
        level: riskLevel,
        signals: riskSignals,
      },
      payment,
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown contract tool: ${name}`);
}