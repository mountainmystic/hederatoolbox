// contract/tools.js - Smart Contract Abstraction tool definitions and handlers
import axios from "axios";
import { chargeForTool } from "../../payments.js";

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
        api_key: { type: "string", description: "Your AgentLens API key" },
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
        api_key: { type: "string", description: "Your AgentLens API key" },
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
        api_key: { type: "string", description: "Your AgentLens API key" },
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

    // Fetch contract info first
    const contractRes = await axios.get(`${base}/api/v1/contracts/${args.contract_id}`)
      .catch(() => ({ data: {} }));
    const contract = contractRes.data;

    // Build function selector (first 4 bytes of keccak256 of function signature)
    // For common functions we use known selectors
    const KNOWN_SELECTORS = {
      "name":           "0x06fdde03",
      "symbol":         "0x95d89b41",
      "decimals":       "0x313ce567",
      "totalSupply":    "0x18160ddd",
      "balanceOf":      "0x70a08231",
      "owner":          "0x8da5cb5b",
      "paused":         "0x5c975abb",
      "getOwner":       "0x893d20e8",
      "getFeeSchedule": "0xb8d24c4d",
    };

    const funcName = args.function_name;
    const selector = KNOWN_SELECTORS[funcName] || null;

    // Try mirror node eth_call simulation via contract results
    let callResult = null;
    let callError = null;

    if (selector) {
      try {
        // Use mirror node to simulate the call
        const callRes = await axios.post(
          `${base}/api/v1/contracts/call`,
          {
            data: selector,
            to: contract.evm_address || args.contract_id,
            gas: 100000,
            gasPrice: 0,
          }
        );
        callResult = callRes.data;
      } catch (e) {
        callError = e.response?.data?.detail || e.message;
      }
    }

    // Also fetch recent results for this function from history
    const resultsRes = await axios.get(
      `${base}/api/v1/contracts/${args.contract_id}/results?limit=25&order=desc`
    ).catch(() => ({ data: { results: [] } }));
    const results = resultsRes.data.results || [];

    // Parse call result if available
    let parsedResult = null;
    if (callResult?.result) {
      const hex = callResult.result.replace("0x", "");
      // Try to decode common return types
      if (hex.length === 64) {
        // Could be uint256 or address
        const asNumber = parseInt(hex, 16);
        const asAddress = "0x" + hex.slice(24);
        parsedResult = {
          raw_hex: "0x" + hex,
          as_uint256: asNumber.toString(),
          as_address: asAddress,
          note: "Raw result decoded as both uint256 and address - interpret based on function context",
        };
      } else if (hex.length > 64) {
        // Could be a string
        try {
          const strData = hex.slice(128);
          const bytes = [];
          for (let i = 0; i < strData.length; i += 2) {
            bytes.push(parseInt(strData.substr(i, 2), 16));
          }
          const str = String.fromCharCode(...bytes).replace(/\0/g, "").trim();
          if (str.length > 0 && str.length < 100) {
            parsedResult = { raw_hex: "0x" + hex, as_string: str };
          } else {
            parsedResult = { raw_hex: "0x" + hex };
          }
        } catch (e) {
          parsedResult = { raw_hex: "0x" + hex };
        }
      }
    }

    return {
      contract_id: args.contract_id,
      evm_address: contract.evm_address || null,
      function_called: funcName,
      function_params: args.function_params || [],
      abi_hint: args.abi_hint || null,
      selector_used: selector,
      call_result: parsedResult,
      call_error: callError,
      selector_known: !!selector,
      note: !selector
        ? "Function '" + funcName + "' is not in the known selector list. Known functions: " + Object.keys(KNOWN_SELECTORS).join(", ")
        : callError
        ? "Call simulation failed - contract may require parameters or use a non-standard ABI."
        : "Call completed successfully.",
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
    const successCount = results.filter(r => r.status === "0x1").length;
    const failCount = results.filter(r => r.status !== "0x1" && r.status).length;

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
    if (failCount > successCount && results.length > 5) { riskScore += 20; riskSignals.push("High failure rate - more failed calls than successful ones"); }
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