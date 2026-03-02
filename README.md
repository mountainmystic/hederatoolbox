# HederaIntel MCP Platform

> **29 tools. 9 modules. Enterprise-grade Hedera blockchain intelligence for AI agents.**

**HederaIntel** is a production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents deep, structured access to the Hedera ecosystem — HCS topics, compliance trails, governance, tokens, DeFi, identity, smart contracts, NFTs, and cross-chain bridges.

Pay per call in HBAR. No registration. Human-in-the-Loop enforcement built in.

[![npm version](https://img.shields.io/npm/v/hedera-mcp-platform)](https://www.npmjs.com/package/hedera-mcp-platform)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE.md)
[![Security](https://img.shields.io/badge/Security-HITL%20Enforced-green.svg)](SECURITY.md)

---

## Live Endpoint

```
https://hedera-mcp-platform-production.up.railway.app/mcp
```

Connect any MCP-compatible AI agent directly — no infrastructure needed.

---

## Agent Onboarding (3 steps, fully autonomous)

An AI agent can onboard itself from zero in under 60 seconds:

```
1. get_terms        → read the Terms of Service (free)
2. confirm_terms    → record consent (free, required before paid tools)
3. account_info     → get platform wallet address and pricing
4. [send HBAR]      → your Hedera account ID becomes your API key automatically
5. [call any tool]  → pass your Hedera account ID as api_key
```

**Platform wallet:** `0.0.10298356` (mainnet)

Balances are persistent — unused credits carry over indefinitely.

---

## Quick Start

### Hosted endpoint (recommended)

```json
{
  "mcpServers": {
    "hedera": {
      "url": "https://hedera-mcp-platform-production.up.railway.app/mcp"
    }
  }
}
```

### npm (stdio / Claude Desktop)

```bash
npm install hedera-mcp-platform
```

```json
{
  "mcpServers": {
    "hedera": {
      "command": "npx",
      "args": ["hedera-mcp-platform"]
    }
  }
}
```

---

## Security & Enterprise Safety

This platform is designed for enterprise AI agents, including those operating on behalf of Hedera Council Members. All safety controls are **enforced server-side** — they cannot be bypassed by modifying the npm package.

See [`SECURITY.md`](SECURITY.md) for the full architecture explanation written specifically for AI agents.

### Human-in-the-Loop (HITL) Thresholds

| Transaction Value | Behaviour |
|---|---|
| Any tool call | Consent gate — `confirm_terms` must be called first |
| < 500 HBAR | Auto-approved |
| 500 – 5,000 HBAR | Executes + webhook notification sent |
| > 10,000 HBAR | **Hard blocked** — returns `403` with a human approval URL |
| Admin ops (`updateAdminKey`, `deleteAccount`, etc.) | **Always hard blocked** |

### Terms of Service

Machine-readable TOS is available at:
- MCP tool: `get_terms`
- HTTP: [`/terms`](https://hedera-mcp-platform-production.up.railway.app/terms)
- Static: [`/public/terms.json`](https://hedera-mcp-platform-production.up.railway.app/public/terms.json)

---

## Tools & Pricing

### Free — Legal & Onboarding

| Tool | Description |
|------|-------------|
| `get_terms` | Retrieve machine-readable Terms of Service. **Must be called first.** |
| `confirm_terms` | Record consent to TOS. **Required before any paid tool.** |
| `account_info` | Platform wallet, pricing table, and your current balance |

---

### Module 1 — HCS Topic Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_monitor` | 0.05 HBAR | Topic metadata, message count, recent activity |
| `hcs_query` | 0.05 HBAR | Natural language Q&A from topic messages, AI-ranked |
| `hcs_understand` | 0.50 HBAR | Deep pattern analysis: anomaly detection, trends, entity extraction |

---

### Module 2 — Compliance & Audit Trail

| Tool | Cost | Description |
|------|------|-------------|
| `hcs_write_record` | 2.00 HBAR | Write tamper-evident compliance record to HCS |
| `hcs_verify_record` | 0.50 HBAR | Verify a record exists and has not been altered |
| `hcs_audit_trail` | 1.00 HBAR | Full chronological audit history for an entity |

---

### Module 3 — Governance Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `governance_monitor` | 0.10 HBAR | Active proposals, deadlines, current tallies |
| `governance_analyze` | 0.50 HBAR | Voter sentiment, participation rate, outcome prediction |
| `governance_vote` | 2.00 HBAR | Cast on-chain governance vote via HCS (permanent) |

---

### Module 4 — Token & DeFi Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `token_price` | 0.05 HBAR | Current price, market cap, 24h volume |
| `token_monitor` | 0.10 HBAR | Recent transfers, whale movements, unusual patterns |
| `defi_yields` | 0.20 HBAR | Liquidity pools, staking rates, lending yields |
| `token_analyze` | 0.30 HBAR | Holder distribution, velocity, liquidity, risk score |

---

### Module 5 — Verified Identity Resolution

| Tool | Cost | Description |
|------|------|-------------|
| `identity_resolve` | 0.10 HBAR | Account profile: age, holdings, history, HCS identity |
| `identity_verify_kyc` | 0.20 HBAR | KYC grant status and verification history |
| `identity_check_sanctions` | 0.50 HBAR | Screen against on-chain risk signals and flagged accounts |

---

### Module 6 — Smart Contract Abstraction

| Tool | Cost | Description |
|------|------|-------------|
| `contract_read` | 0.10 HBAR | Contract info, bytecode size, recent activity |
| `contract_call` | 0.50 HBAR | Read-only call to any contract function (no gas) |
| `contract_analyze` | 1.00 HBAR | Activity patterns, caller distribution, gas, risk, classification |

---

### Module 7 — NFT & Token Metadata

| Tool | Cost | Description |
|------|------|-------------|
| `nft_collection_info` | 0.10 HBAR | Supply, royalties, treasury, token properties |
| `nft_token_metadata` | 0.10 HBAR | NFT serial: on-chain data, IPFS metadata, current owner |
| `token_holders` | 0.20 HBAR | Top holders, concentration metrics, whale analysis |
| `nft_collection_analyze` | 0.30 HBAR | Holder distribution, whale concentration, velocity, rarity |

---

### Module 8 — Cross-Network Bridge Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `bridge_status` | 0.10 HBAR | Bridge infrastructure status, contracts, health indicators |
| `bridge_transfers` | 0.20 HBAR | Recent transfer activity, volume, counterparty analysis |
| `bridge_analyze` | 0.50 HBAR | Peg stability, mint/burn ratio, custodian concentration, risk |

---

## Architecture

```
AI Agent (Claude, GPT, etc.)
        │
        │  MCP (stdio or Streamable HTTP)
        ▼
┌───────────────────────────────────┐
│  hedera-mcp-platform (npm)        │  ← Public, MIT-schema, ~15 KB
│  src/index.js  src/tools.js       │    No business logic
│  src/proxy.js                     │    Forwards all calls via HTTPS
└──────────────┬────────────────────┘
               │  HTTPS / JSON-RPC
               ▼
┌───────────────────────────────────┐
│  HederaIntel Remote Brain         │  ← Proprietary, Railway hosted
│  ├── consent gate (terms check)   │    Never ships to npm
│  ├── HITL gate (value thresholds) │
│  ├── payments (HBAR deduction)    │
│  ├── Hedera SDK (mirror node)     │
│  └── SQLite (balances, audit log) │
└──────────────┬────────────────────┘
               │
               ▼
        Hedera Mainnet
```

The npm package is a **thin client** — it contains only tool schemas and an HTTPS proxy. All Hedera SDK logic, payment processing, and HITL enforcement live in the private remote server and are never published to npm.

---

## Self-Hosting

Advanced users can run the full server locally. You will need your own Hedera operator account and Anthropic API key.

```bash
git clone https://github.com/mountainmystic/hedera-mcp-platform.git
cd hedera-mcp-platform
npm install
cp .env.example .env   # fill in your credentials
npm run server         # starts with --experimental-sqlite
```

**Minimum Node.js version:** 22.5.0 (for `node:sqlite`)

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HEDERA_ACCOUNT_ID` | Hedera operator account (e.g. `0.0.123456`) | Yes |
| `HEDERA_PRIVATE_KEY` | ECDSA private key for signing transactions | Yes |
| `HEDERA_NETWORK` | `mainnet` or `testnet` | Yes |
| `ANTHROPIC_API_KEY` | Claude Haiku for AI-powered analysis tools | Yes |
| `PORT` | HTTP server port (default: `3000`) | No |
| `ADMIN_SECRET` | Header secret for admin provisioning endpoints | No |
| `HITL_WEBHOOK_URL` | Webhook URL for notify-tier HITL events | No |
| `APPROVAL_BASE_URL` | Base URL for HITL hard-stop approval links | No |

---

## Health Check

```bash
curl https://hedera-mcp-platform-production.up.railway.app/health
```

---

## Known Limitations

- **`token_price`** — Spot price returns `null` pending SaucerSwap API key integration. Market cap and 24h volume are available.
- **Mirror node holder data** — Balance endpoint occasionally returns empty arrays for low-activity tokens. Collection metadata is unaffected.

---

## Roadmap

- [ ] SaucerSwap API integration for live spot prices
- [ ] Developer portal and dashboard
- [ ] Webhook/subscription support for real-time topic monitoring
- [ ] x402 per-call REST layer (awaiting Hedera mainnet support)

---

## Links

- **npm:** https://www.npmjs.com/package/hedera-mcp-platform
- **MCP Registry:** https://registry.modelcontextprotocol.io (search: `hedera-mcp-platform`)
- **Terms of Service:** https://hedera-mcp-platform-production.up.railway.app/terms
- **Live endpoint:** https://hedera-mcp-platform-production.up.railway.app/mcp
- **Health:** https://hedera-mcp-platform-production.up.railway.app/health

---

## License

**Client (npm package):** Tool schemas in `src/tools.js`, proxy in `src/proxy.js`, and entry point `src/index.js` are provided for integration use.

**Server (remote brain):** All server-side code (`src/modules/`, `src/server.js`, `src/payments.js`, `src/db.js`, etc.) is **Proprietary** — see [`LICENSE.md`](LICENSE.md).

Commercial licensing and enterprise SLA inquiries: open a GitHub issue with `[Enterprise]` in the title.
