// payments.js - Shared HBAR micropayment system for all modules

const COSTS = {
  // Module 1 - HCS Topic Intelligence
  hcs_monitor:              { tinybars: 5000000,   hbar: "0.0500" },
  hcs_query:                { tinybars: 5000000,   hbar: "0.0500" },
  hcs_understand:           { tinybars: 50000000,  hbar: "0.5000" },
  // Module 2 - Compliance & Audit Trail
  hcs_write_record:         { tinybars: 200000000, hbar: "2.0000" },
  hcs_verify_record:        { tinybars: 50000000,  hbar: "0.5000" },
  hcs_audit_trail:          { tinybars: 100000000, hbar: "1.0000" },
  // Module 3 - Governance Intelligence
  governance_monitor:       { tinybars: 10000000,  hbar: "0.1000" },
  governance_analyze:       { tinybars: 50000000,  hbar: "0.5000" },
  governance_vote:          { tinybars: 200000000, hbar: "2.0000" },
  // Module 4 - Token & DeFi Intelligence
  token_price:              { tinybars: 5000000,   hbar: "0.0500" },
  token_analyze:            { tinybars: 30000000,  hbar: "0.3000" },
  defi_yields:              { tinybars: 20000000,  hbar: "0.2000" },
  token_monitor:            { tinybars: 10000000,  hbar: "0.1000" },
  // Module 5 - Verified Identity Resolution
  identity_resolve:         { tinybars: 10000000,  hbar: "0.1000" },
  identity_verify_kyc:      { tinybars: 20000000,  hbar: "0.2000" },
  identity_check_sanctions: { tinybars: 50000000,  hbar: "0.5000" },
  // Module 6 - Smart Contract Abstraction
  contract_read:            { tinybars: 10000000,  hbar: "0.1000" },
  contract_call:            { tinybars: 50000000,  hbar: "0.5000" },
  contract_analyze:         { tinybars: 100000000, hbar: "1.0000" },
  // Module 7 - NFT & Token Metadata
  nft_collection_info:      { tinybars: 10000000,  hbar: "0.1000" },
  nft_token_metadata:       { tinybars: 10000000,  hbar: "0.1000" },
  nft_collection_analyze:   { tinybars: 30000000,  hbar: "0.3000" },
  token_holders:            { tinybars: 20000000,  hbar: "0.2000" },
  // Module 8 - Cross-Network Bridge Intelligence
  bridge_status:            { tinybars: 10000000,  hbar: "0.1000" },
  bridge_transfers:         { tinybars: 20000000,  hbar: "0.2000" },
  bridge_analyze:           { tinybars: 50000000,  hbar: "0.5000" },
};

const accounts = new Map();

function getAccount(apiKey) {
  if (!accounts.has(apiKey)) {
    accounts.set(apiKey, { balance: 1000000000 }); // 10 HBAR starting balance
  }
  return accounts.get(apiKey);
}

export function chargeForTool(toolName, apiKey) {
  const cost = COSTS[toolName];
  if (!cost) return null;

  const account = getAccount(apiKey);
  if (account.balance < cost.tinybars) {
    throw new Error(
      "Insufficient HBAR balance. Required: " + cost.hbar + " HBAR. Please top up your AgentLens account."
    );
  }

  account.balance -= cost.tinybars;
  const remainingHbar = (account.balance / 100000000).toFixed(4);
  return {
    charged_hbar: cost.hbar,
    remaining_hbar: remainingHbar,
  };
}

export function getCosts() {
  return COSTS;
}

export function getBalance(apiKey) {
  const account = getAccount(apiKey);
  return (account.balance / 100000000).toFixed(4);
}