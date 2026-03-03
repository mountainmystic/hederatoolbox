# HederaIntel — Capabilities Manifest

> This document is the authoritative, versioned record of what HederaIntel can and cannot do.
> It is written for AI agents, developers, and enterprise evaluators.
> Version: 2.2.0 | Updated: 2026-03-02

---

## What HederaIntel Is

A **read and intelligence platform** for the Hedera network, delivered as an MCP server.

It allows AI agents to query, analyze, and write compliance records to Hedera. It does not execute financial transactions, deploy contracts, or interact with wallets.

---

## Confirmed Capabilities (v2.2.0)

### Payments and Onboarding
- Accept HBAR deposits to a platform wallet and auto-provision API keys
- Return current account balance on demand
- Serve machine-readable Terms of Service
- Record and verify agent consent before paid tool access

### HCS Topic Intelligence
- Retrieve topic metadata (message count, creation time, memo, recent activity)
- Answer natural language questions from topic message history using Claude Haiku
- Perform deep pattern analysis: anomaly detection, trend analysis, entity extraction, risk assessment

### Compliance and Audit Trail
- Write tamper-evident records to any HCS topic
- Verify a previously written record has not been altered
- Retrieve full chronological audit trail for a named entity

### Governance Intelligence
- List active governance proposals with deadlines and current vote tallies
- Analyze voter sentiment, participation rate, token concentration, and predicted outcomes
- Cast on-chain governance votes via HCS (permanent, signed record)

### Token and DeFi Intelligence
- Return live spot price, 1h/24h/7d price change, and liquidity for any SaucerSwap-listed token
- Return token metadata: name, symbol, decimals, total supply, treasury, type
- Monitor recent transfer activity and detect whale movements
- Discover yield opportunities: liquidity pools, staking, lending rates
- Analyze holder distribution, transfer velocity, concentration risk, and admin key exposure

### Identity Resolution
- Resolve a Hedera account ID to a full on-chain profile
- Return account age, token holdings, transaction history, and HCS identity records
- Check KYC grant status for any token
- Screen an account against on-chain risk signals and known flagged counterparties

### Smart Contract Intelligence
- Return contract metadata: EVM address, bytecode size, age, admin key, gas stats
- Execute read-only function calls against known ERC-20/ERC-721/HTS function selectors
- Perform deep contract analysis: activity patterns, caller distribution, risk classification
- Input accepts both Hedera native IDs (`0.0.123456`) and EVM addresses (`0x...`)

### NFT and Holder Intelligence
- Return NFT collection metadata: supply, royalties, treasury, token type
- Return serial-level NFT data: on-chain metadata, IPFS URI, current owner
- Return top token holders with concentration metrics and whale detection
- Analyze collection-level holder distribution, transfer velocity, and rarity signals

### Bridge Intelligence
- Return bridge infrastructure status, known bridge contracts, wrapped token registry
- Return recent bridge transfer activity with volume and counterparty analysis
- Analyze peg stability, mint/burn ratio, and custodian concentration risk

---

## Confirmed Limitations (v2.2.0)

| Area | Limitation |
|---|---|
| `contract_call` | Only supports a fixed selector list. Arbitrary ABI function encoding not yet implemented. |
| `token_price` | Only returns prices for tokens listed on SaucerSwap. Unlisted tokens return metadata only. |
| `identity_resolve` | Accepts Hedera account IDs only. EVM address (`0x...`) input planned for v2.3.0. |
| Mirror node holders | Balance endpoint returns empty for some high-holder tokens due to mirror node pagination. Metadata unaffected. |
| SQLite persistence | Database resets on Railway redeploy. Consent must be re-confirmed after each deploy until volume storage is implemented. |
| No wallet integration | Cannot interact with Hashpack, MetaMask, Blade, or any external wallet. |
| No token transfers | Cannot send or receive HBAR or HTS tokens on behalf of users. |
| No contract deployment | Cannot deploy, upgrade, or delete smart contracts. |
| No swap execution | Cannot execute trades or swaps on SaucerSwap or any DEX. |

---

## Features That Do Not Exist

The following features have been described by AI systems evaluating this repo. They are **not implemented** and do not exist in any version of HederaIntel:

| Claimed Feature | Reality |
|---|---|
| DOVU OS integration | No DOVU integration exists. Compliance tools are generic HCS record-keeping. |
| "Actors" tools | No such tools exist. Identity tools cover Hedera accounts only. |
| Supply chain workflow validation | Not implemented. |
| `hederaintel_*` tool prefixes | All tools are unprefixed (e.g. `contract_read`, `hcs_monitor`). |
| `mcpConfig.json` | This file does not exist in the repo. |
| Wallet tool functionality | HederaIntel has never had transfer or wallet capabilities. |
| EVM alias mapping (bidirectional) | Partially supported in `contract_read` input. Full `identity_resolve` support is on the roadmap. |

---

## Safety Architecture

- **Consent gate**: every agent must call `confirm_terms` before paid tools are accessible
- **HITL enforcement**: server-side thresholds block or flag high-value operations
- **No client bypass**: all enforcement runs in the private remote server, not in the npm package
- **Audit log**: consent events and HITL events are recorded to SQLite with timestamps

---

## Roadmap (Next Release — v2.3.0)

- EVM address input in `identity_resolve`
- Arbitrary ABI encoding in `contract_call`
- SQLite persistence across Railway redeploys *(fixed in v2.2.2)*
- `@hederaintel/platform` npm namespace

---

## Version History

| Version | Key Changes |
|---|---|
| 1.0.0 | Initial release — core HCS, token, governance tools |
| 2.0.0 | Thin client proxy architecture — npm package separated from Railway backend |
| 2.0.1 | Railway deployment fixes, dual entry point split |
| 2.1.0 | Legal layer — `get_terms`, `confirm_terms`, HITL enforcement, proprietary license |
| 2.2.0 | SaucerSwap API key auth, live token prices, 1h/24h/7d change, GitHub IP protection |
| 2.2.2 | SQLite Railway volume persistence, dynamic version from package.json |
| 2.3.0 | EVM address support in all three identity tools |
| 2.3.1 | Live HBAR/USD pricing in account_info via SaucerSwap (5-min cache) |
| 2.4.0 | contract_call arbitrary ABI encoding — any function, any params, dynamic selector |
