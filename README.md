# HederaIntel
**Hedera MCP Platform**

> **27 tools. 9 modules. One unified MCP server for Hedera blockchain intelligence.**

**HederaIntel** is the intelligence layer for AI agents operating on Hedera. A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents deep, structured access to the Hedera ecosystem — HCS topics, compliance trails, governance, tokens, DeFi, identity, smart contracts, NFTs, and cross-chain bridges. Pay per call in HBAR. No registration required.

[![npm version](https://img.shields.io/npm/v/hedera-mcp-platform)](https://www.npmjs.com/package/hedera-mcp-platform)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Live Endpoint

```
https://hedera-mcp-platform-production.up.railway.app/mcp
```

Connect any MCP-compatible AI agent directly — no infrastructure needed.

---

## How Payments Work

This platform uses **agent-native HBAR payments**. There is no registration form, no email, no OAuth flow. An AI agent can onboard itself autonomously in under 30 seconds:

1. Call `account_info` (free) — get the platform wallet address and full pricing table
2. Send any amount of HBAR to the platform wallet from your Hedera account
3. Your Hedera account ID becomes your API key automatically within 10 seconds
4. Pass your Hedera account ID as the `api_key` parameter in any tool call

Your balance is persistent — unused credit carries over indefinitely. Call `account_info` with your account ID at any time to check your remaining balance.

**Platform wallet:** `0.0.10298356` (mainnet)

---

## Quick Start

### Use the hosted endpoint (recommended)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "hedera": {
      "url": "https://hedera-mcp-platform-production.up.railway.app/mcp"
    }
  }
}
```

Then in your agent, call `account_info` first — it will tell you everything you need to know to fund your account and start making calls.

### Run locally

```bash
git clone https://github.com/mountainmystic/hedera-mcp-platform.git
cd hedera-mcp-platform
npm install
cp .env.example .env   # fill in your credentials
npm start
```

**Requirements:** Node.js ≥ 22.5.0

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HEDERA_ACCOUNT_ID` | Your Hedera operator account (e.g. `0.0.123456`) | Yes |
| `HEDERA_PRIVATE_KEY` | ECDSA private key for signing transactions | Yes |
| `HEDERA_NETWORK` | `mainnet` or `testnet` | Yes |
| `ANTHROPIC_API_KEY` | Claude Haiku for AI-powered analysis tools | Yes |
| `ADMIN_SECRET` | Secret header for admin provisioning endpoints | No |
| `HCS_COMPLIANCE_TOPIC_ID` | Default HCS topic for compliance tools (e.g. `0.0.10305125`) | No |
| `PORT` | HTTP server port (default: `3000`) | No |

---

## Modules & Tools

All tools except `account_info` require an `api_key` parameter (your Hedera account ID). Each call is metered and deducted from your balance.

---

### Module 0 — Account & Onboarding

| Tool | Description | Cost |
|------|-------------|------|
| `account_info` | Platform wallet address, full pricing table, and your current balance | **Free** |

This is the agent onboarding entrypoint. Call it first. It tells an agent exactly how to fund an account and what everything costs.

---

### Module 1 — HCS Topic Intelligence

Monitor, query, and deeply analyze any Hedera Consensus Service topic.

| Tool | Description | Cost |
|------|-------------|------|
| `hcs_monitor` | Topic metadata, message count, creation time, and recent activity | 0.05 HBAR |
| `hcs_query` | Natural language question answered from topic messages, AI-ranked | 0.05 HBAR |
| `hcs_understand` | Deep pattern analysis: anomaly detection, trend analysis, entity extraction, risk assessment | 0.50 HBAR |

**Example use cases:** Monitor governance forums, audit log topics, oracle feeds, token launch announcements.

---

### Module 2 — Compliance & Audit Trail

Write and verify tamper-evident records on Hedera — an immutable on-chain compliance layer for any workflow.

| Tool | Description | Cost |
|------|-------------|------|
| `hcs_write_record` | Write a compliance record to HCS with timestamp proof | 2.00 HBAR |
| `hcs_verify_record` | Verify a record exists and has not been tampered with | 0.50 HBAR |
| `hcs_audit_trail` | Full chronological audit history for an entity | 1.00 HBAR |

All compliance tools default to the shared HederaIntel platform topic (`0.0.10305125`) when no `topic_id` is supplied.

**Example use cases:** KYC approval records, trade approvals, document signing workflows, regulatory audit trails.

---

### Module 3 — Governance Intelligence

Track and participate in on-chain governance across Hedera DAOs and protocols.

| Tool | Description | Cost |
|------|-------------|------|
| `governance_monitor` | Active proposals, voting deadlines, current tallies | 0.10 HBAR |
| `governance_analyze` | Deep proposal analysis: voter sentiment, participation rate, token concentration, outcome prediction | 0.50 HBAR |
| `governance_vote` | Cast a governance vote on-chain via HCS (permanent) | 2.00 HBAR |

**Example use cases:** Automated governance bots, DAO dashboards, voting agents.

---

### Module 4 — Token & DeFi Intelligence

Real-time token data, market analytics, and DeFi yield discovery across the Hedera ecosystem.

| Tool | Description | Cost |
|------|-------------|------|
| `token_price` | Current price, market cap, and 24h trading volume | 0.05 HBAR |
| `token_analyze` | Holder distribution, transfer velocity, liquidity, and risk scoring | 0.30 HBAR |
| `defi_yields` | Current yield opportunities: liquidity pools, staking, lending rates | 0.20 HBAR |
| `token_monitor` | Recent transfer activity, whale movements, and unusual trading patterns | 0.10 HBAR |

**Example use cases:** DeFi portfolio agents, yield optimizers, token risk screeners.

---

### Module 5 — Verified Identity Resolution

Resolve and screen Hedera accounts with on-chain identity profiles and risk signals.

| Tool | Description | Cost |
|------|-------------|------|
| `identity_resolve` | Account profile: age, token holdings, transaction history, HCS identity records | 0.10 HBAR |
| `identity_verify_kyc` | KYC grant status and verification history for a token | 0.20 HBAR |
| `identity_check_sanctions` | Screen account against on-chain risk signals, counterparty patterns, flagged accounts | 0.50 HBAR |

**Example use cases:** Onboarding flows, compliance screening, counterparty due diligence.

---

### Module 6 — Smart Contract Abstraction

Inspect and interact with Hedera smart contracts without needing ABI knowledge.

| Tool | Description | Cost |
|------|-------------|------|
| `contract_read` | Contract info, bytecode size, recent activity, storage details | 0.10 HBAR |
| `contract_call` | Execute a read-only call to any contract function (no gas, no transaction) | 0.50 HBAR |
| `contract_analyze` | Deep analysis: activity patterns, caller distribution, gas usage, risk assessment, functional classification | 1.00 HBAR |

**Example use cases:** Contract auditing agents, DeFi protocol monitoring, ERC-20/ERC-721/HTS introspection.

---

### Module 7 — NFT & Token Metadata

Full NFT collection analytics and token holder intelligence.

| Tool | Description | Cost |
|------|-------------|------|
| `nft_collection_info` | Collection metadata: supply, royalties, treasury, token properties | 0.10 HBAR |
| `nft_token_metadata` | Specific NFT serial: on-chain data, IPFS/metadata URI, current owner | 0.10 HBAR |
| `nft_collection_analyze` | Holder distribution, whale concentration, transfer velocity, floor price signals, rarity insights | 0.30 HBAR |
| `token_holders` | Top holders, concentration metrics, whale analysis | 0.20 HBAR |

**Example use cases:** NFT market intelligence, rarity tools, holder distribution dashboards.

---

### Module 8 — Cross-Network Bridge Intelligence

Monitor and analyze bridged assets flowing between Hedera and other chains via HashPort.

| Tool | Description | Cost |
|------|-------------|------|
| `bridge_status` | Current bridge infrastructure status, known bridge contracts, wrapped token registry, health indicators | 0.10 HBAR |
| `bridge_transfers` | Recent bridge transfer activity: volume, frequency, counterparty analysis | 0.20 HBAR |
| `bridge_analyze` | Deep bridge analysis: peg stability, mint/burn ratio, custodian concentration, risk assessment | 0.50 HBAR |

**Supported bridged assets:** USDC, USDT, WETH, WBTC, and other HashPort-registered tokens.

**Example use cases:** Bridge risk monitoring, cross-chain DeFi agents, custodian concentration alerts.

---

## Pricing Summary

| Tier | Tools | Cost |
|------|-------|------|
| **Free** | `account_info` | 0 HBAR |
| **Micro** | `hcs_monitor`, `hcs_query`, `token_price` | 0.05 HBAR |
| **Low** | `governance_monitor`, `token_monitor`, `identity_resolve`, `contract_read`, `nft_collection_info`, `nft_token_metadata`, `bridge_status` | 0.10 HBAR |
| **Standard** | `identity_verify_kyc`, `defi_yields`, `bridge_transfers`, `token_holders`, `token_analyze`, `nft_collection_analyze` | 0.20–0.30 HBAR |
| **Analysis** | `hcs_understand`, `hcs_verify_record`, `identity_check_sanctions`, `governance_analyze`, `contract_call`, `bridge_analyze` | 0.50 HBAR |
| **Deep** | `contract_analyze`, `hcs_audit_trail` | 1.00 HBAR |
| **Write** | `hcs_write_record`, `governance_vote` | 2.00 HBAR |

---

## Architecture

```
hedera-mcp-platform/
├── src/
│   ├── index.js          # Entry point — stdio + Streamable HTTP transports
│   ├── server.js         # MCP server, tool registry, request routing
│   ├── payments.js       # HBAR charge logic, tool cost table
│   ├── db.js             # SQLite persistence — accounts, balances, transactions
│   ├── watcher.js        # Hedera deposit watcher — polls mirror node every 10s
│   └── modules/
│       ├── account/      # Account info & agent onboarding (free)
│       ├── hcs/          # HCS Topic Intelligence
│       ├── compliance/   # Compliance & Audit Trail
│       ├── governance/   # Governance Intelligence
│       ├── token/        # Token & DeFi Intelligence
│       ├── identity/     # Verified Identity Resolution
│       ├── contract/     # Smart Contract Abstraction
│       ├── nft/          # NFT & Token Metadata
│       └── bridge/       # Cross-Network Bridge Intelligence
```

The server supports two MCP transports:
- **Streamable HTTP** (`/mcp`) — for remote AI agents and Claude.ai integrations
- **stdio** — for local MCP client configurations (Claude Desktop, etc.)

The deposit watcher polls the Hedera mirror node every 10 seconds. When it detects a new HBAR transfer to the platform wallet, it automatically creates or credits the sender's account. The sender's Hedera account ID becomes their API key — no human involvement required.

---

## Connecting to Claude

### Claude.ai (via MCP connector)

In Claude.ai settings → Integrations, add:

```
https://hedera-mcp-platform-production.up.railway.app/mcp
```

### Claude Desktop (local)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hedera": {
      "command": "node",
      "args": ["/path/to/hedera-mcp-platform/src/index.js"]
    }
  }
}
```

---

## Health Check

```bash
curl https://hedera-mcp-platform-production.up.railway.app/
```

Returns current status, network, all tool names, and per-tool pricing.

---

## Known Limitations

- **`token_price`** — Spot price returns `null` pending SaucerSwap API key. Market cap and volume are available.
- **`bridge_transfers`** — Generic network-wide transfer scanning may return low counts for very low-activity bridged tokens. Top holder data is always returned.

---

## Roadmap

- [ ] SaucerSwap API integration for live token prices *(in progress)*
- [ ] x402 per-call REST layer — pay per request with no account needed, once Hedera mainnet support matures
- [ ] HederaIntel developer portal and dashboard
- [ ] Webhook/subscription support for real-time topic monitoring

---

## Links

- **npm:** https://www.npmjs.com/package/hedera-mcp-platform
- **MCP Registry:** https://registry.modelcontextprotocol.io (search: `hedera-mcp-platform`)
- **GitHub:** https://github.com/mountainmystic/hedera-mcp-platform
- **Live endpoint:** https://hedera-mcp-platform-production.up.railway.app/mcp

---

## License

MIT
