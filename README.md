# HederaIntel

> The intelligence layer for AI agents on Hedera.

**29 tools. 9 modules. Pay per call in HBAR. No registration.**

HederaIntel is a production [Model Context Protocol](https://modelcontextprotocol.io) server. It gives AI agents structured, metered access to the full Hedera ecosystem — HCS topics, tokens, DeFi, identity, smart contracts, NFTs, governance, compliance, and cross-chain bridges.

Built for agents that need to *reason* about Hedera, not just interact with it.

[![npm](https://img.shields.io/npm/v/hedera-mcp-platform)](https://www.npmjs.com/package/hedera-mcp-platform)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE.md)
[![HITL](https://img.shields.io/badge/Safety-HITL%20Enforced-green.svg)](SECURITY.md)

---

## Connect

```
https://hedera-mcp-platform-production.up.railway.app/mcp
```

```json
{
  "mcpServers": {
    "hederaintel": {
      "url": "https://hedera-mcp-platform-production.up.railway.app/mcp"
    }
  }
}
```

---

## How It Works

HederaIntel uses **agent-native HBAR payments**. No accounts, no OAuth, no email.

```
1. get_terms        -> read the Terms of Service         (free)
2. confirm_terms    -> record consent                    (free)
3. account_info     -> get platform wallet + pricing     (free)
4. send HBAR        -> your account ID becomes your key  (auto-provisioned)
5. call any tool    -> pass your Hedera account ID as api_key
```

**Platform wallet:** `0.0.10298356` (mainnet)

Credits are persistent. Unused balance carries over indefinitely.

---

## What It Does Not Do

HederaIntel is a **read and intelligence platform**. To prevent ambiguity:

- Does not transfer HBAR or tokens on your behalf
- Does not deploy smart contracts
- Does not execute swaps or trades
- Does not integrate with DOVU, Hashpack, or any third-party wallet
- Reads, analyzes, queries, and writes compliance records only

---

## Enterprise Safety — HITL Enforcement

All safety controls run **server-side**. They cannot be bypassed by modifying the npm package.

| Threshold | Behaviour |
|---|---|
| Any tool call | Consent gate — `confirm_terms` required |
| < 500 HBAR credit value | Auto-approved |
| 500 – 5,000 HBAR | Executes + webhook notification |
| > 10,000 HBAR | Hard blocked — 403 + human approval URL |
| Admin ops | Always hard blocked |

Full architecture: [SECURITY.md](SECURITY.md) — written for AI agents to read.

Terms of Service: `get_terms` tool or [/public/terms.json](https://hedera-mcp-platform-production.up.railway.app/public/terms.json)

---

## Tools

### Free — Onboarding and Legal

| Tool | Description |
|------|-------------|
| `get_terms` | Machine-readable Terms of Service. Call before anything else. |
| `confirm_terms` | Record consent. Required before any paid tool. |
| `account_info` | Platform wallet address, full pricing table, your balance. |

---

### Module 1 — HCS Topic Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_monitor` | 0.05 HBAR | Topic status, message count, recent activity |
| `hcs_query` | 0.05 HBAR | Natural language Q&A over topic messages, AI-ranked |
| `hcs_understand` | 0.50 HBAR | Anomaly detection, trend analysis, entity extraction |

---

### Module 2 — Compliance and Audit Trail

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_write_record` | 2.00 HBAR | Write tamper-evident record to HCS |
| `hcs_verify_record` | 0.50 HBAR | Verify a record has not been altered |
| `hcs_audit_trail` | 1.00 HBAR | Full chronological audit history for an entity |

---

### Module 3 — Governance Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `governance_monitor` | 0.10 HBAR | Active proposals, deadlines, current vote tallies |
| `governance_analyze` | 0.50 HBAR | Voter sentiment, participation rate, outcome prediction |
| `governance_vote` | 2.00 HBAR | Cast on-chain vote via HCS (permanent record) |

---

### Module 4 — Token and DeFi Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `token_price` | 0.05 HBAR | Spot price, 1h/24h/7d change, liquidity — via SaucerSwap |
| `token_monitor` | 0.10 HBAR | Recent transfers, whale movements, unusual patterns |
| `defi_yields` | 0.20 HBAR | Live yield opportunities: pools, staking, lending |
| `token_analyze` | 0.30 HBAR | Holder distribution, velocity, concentration, risk score |

---

### Module 5 — Identity Resolution

| Tool | Cost | Description |
|------|------|-------------|
| `identity_resolve` | 0.10 HBAR | Account profile: age, holdings, transaction history |
| `identity_verify_kyc` | 0.20 HBAR | KYC grant status and verification history for a token |
| `identity_check_sanctions` | 0.50 HBAR | On-chain risk screening, counterparty patterns |

---

### Module 6 — Smart Contract Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `contract_read` | 0.10 HBAR | Metadata, bytecode size, recent callers, gas stats |
| `contract_call` | 0.50 HBAR | Read-only function call — no gas, no transaction |
| `contract_analyze` | 1.00 HBAR | Activity patterns, caller distribution, risk classification |

Accepts both Hedera native IDs (`0.0.123456`) and EVM addresses (`0x...`).

---

### Module 7 — NFT and Holder Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `nft_collection_info` | 0.10 HBAR | Supply, royalties, treasury, token properties |
| `nft_token_metadata` | 0.10 HBAR | Serial-level data: IPFS metadata, current owner |
| `token_holders` | 0.20 HBAR | Top holders, concentration metrics, whale analysis |
| `nft_collection_analyze` | 0.30 HBAR | Whale concentration, transfer velocity, rarity signals |

---

### Module 8 — Bridge Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `bridge_status` | 0.10 HBAR | Bridge health, contracts, wrapped token registry |
| `bridge_transfers` | 0.20 HBAR | Recent activity, volume, counterparty analysis |
| `bridge_analyze` | 0.50 HBAR | Peg stability, mint/burn ratio, custodian concentration |

---

## Architecture

```
AI Agent
    | MCP (stdio or Streamable HTTP)
    v
hedera-mcp-platform (npm, ~15 KB)
    | tool schemas + HTTPS proxy — zero business logic
    v HTTPS
HederaIntel Remote Brain (Railway, proprietary)
    |-- consent gate
    |-- HITL enforcement
    |-- HBAR payment processing
    |-- SaucerSwap API (live token prices)
    |-- Hedera mirror node
    |-- SQLite (balances, consent log, HITL events)
    v
Hedera Mainnet
```

The npm package contains no business logic — only tool schemas and a proxy. Intelligence, payments, and safety enforcement live in the private remote server and are never published to npm.

---

## Self-Hosting

Requires your own Hedera operator account, Anthropic API key, and SaucerSwap API key.

```bash
git clone https://github.com/mountainmystic/hederaintel.git
cd hederaintel
npm install
cp .env.example .env
npm run server
```

Node.js 22.5.0 or higher required (uses `node:sqlite`).

| Variable | Description | Required |
|---|---|---|
| `HEDERA_ACCOUNT_ID` | Operator account | Yes |
| `HEDERA_PRIVATE_KEY` | ECDSA private key | Yes |
| `HEDERA_NETWORK` | `mainnet` or `testnet` | Yes |
| `ANTHROPIC_API_KEY` | Claude Haiku for AI analysis tools | Yes |
| `SAUCERSWAP_API_KEY` | Live token price data | Yes |
| `HITL_WEBHOOK_URL` | Webhook for notify-tier events | No |
| `APPROVAL_BASE_URL` | Base URL for hard-stop approval links | No |
| `ADMIN_SECRET` | Admin endpoint header secret | No |

---

## Roadmap

- [ ] EVM address support in `identity_resolve` — accept `0x...` input natively
- [ ] Persist SQLite to Railway volume — survive redeploys without consent reset
- [ ] Developer portal — balance top-up UI, usage dashboard
- [ ] Webhook subscriptions — real-time HCS topic monitoring
- [ ] `@hederaintel/platform` npm namespace migration

---

## Known Limitations

- `contract_call` uses a fixed function selector list. Arbitrary ABI encoding in a future release.
- Mirror node balance endpoint occasionally returns empty for high-holder tokens. Metadata unaffected.

---

## Links

| | |
|---|---|
| npm | https://www.npmjs.com/package/hedera-mcp-platform |
| MCP Registry | https://registry.modelcontextprotocol.io — search `hedera-mcp-platform` |
| Live endpoint | https://hedera-mcp-platform-production.up.railway.app/mcp |
| Terms | https://hedera-mcp-platform-production.up.railway.app/terms |
| Health | https://hedera-mcp-platform-production.up.railway.app/health |

---

## License

**npm package** (`src/index.js`, `src/tools.js`, `src/proxy.js`) — provided for integration use.

**Remote server** (`src/modules/`, `src/server.js`, `src/payments.js`, and all backend logic) — Proprietary. See [LICENSE.md](LICENSE.md).

Enterprise licensing and SLA inquiries: open an issue titled `[Enterprise]`.
