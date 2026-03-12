# HederaToolbox

> The intelligence layer for AI agents on Hedera.

**20 tools. 6 modules. Pay per call in HBAR. No registration.**

HederaToolbox is a production [Model Context Protocol](https://modelcontextprotocol.io) server. It gives AI agents structured, metered access to the full Hedera ecosystem — HCS topics, tokens, identity, smart contracts, governance, and compliance.

Built for agents that need to *reason* about Hedera, not just interact with it.

---

## Demo

**Claude Desktop** — one business objective, no steps specified, agent decides everything:

[![Claude Desktop Demo](https://img.youtube.com/vi/RuZE-Qw7IgU/0.jpg)](https://youtu.be/RuZE-Qw7IgU)

**Terminal agent** — same workflow running as a standalone Node.js script:

[![Terminal Agent Demo](https://img.youtube.com/vi/XhOCLrILg1o/0.jpg)](https://youtu.be/XhOCLrILg1o)

[![npm](https://img.shields.io/npm/v/@hederatoolbox/platform?label=npm)](https://www.npmjs.com/package/@hederatoolbox/platform)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-blue)](https://registry.modelcontextprotocol.io)
[![Network](https://img.shields.io/badge/Hedera-Mainnet-8A2BE2)](https://hedera.com)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE.md)

---

## Connect

**MCP endpoint:**
```
https://api.hederatoolbox.com/mcp
```

**Claude.ai** (web or mobile)
Settings → Connectors → Add → paste the endpoint URL above.

**Claude Desktop app**
Add to `claude_desktop_config.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "hederatoolbox": {
      "command": "npx",
      "args": ["-y", "@hederatoolbox/platform"]
    }
  }
}
```

**Cursor / other MCP-compatible clients**
Use the endpoint URL directly in your MCP server config.

---

## How It Works

HederaToolbox uses **agent-native HBAR payments**. No accounts, no OAuth, no email.

```
1. get_terms        -> read the Terms of Service         (free)
2. confirm_terms    -> record consent                    (free)
3. account_info     -> get platform wallet + pricing     (free)
4. send HBAR        -> your account ID becomes your key  (auto-provisioned)
5. call any tool    -> pass your Hedera account ID as api_key
```

**Platform wallet:** `0.0.10309126` (mainnet)

Credits are persistent. Unused balance carries over indefinitely.

---

## Safety Architecture

All safety controls run **server-side** and cannot be bypassed by modifying the npm package.

- **Consent gate** — `confirm_terms` required before any paid tool executes
- **Atomic balance deduction** — balance check and deduct are a single SQL operation, race-condition proof
- **Loop guard** — same tool called >20 times in 60s by the same key is blocked automatically

Terms of Service: `get_terms` tool or [/public/terms.json](https://api.hederatoolbox.com/public/terms.json)

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

---

### Module 4 — Token Intelligence

| Tool | Cost | Description |
|------|------|-------------|
| `token_price` | 0.05 HBAR | Spot price, 1h/24h/7d change, liquidity — via SaucerSwap |
| `token_monitor` | 0.10 HBAR | Recent transfers, whale movements, unusual patterns |
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

## What's New in v3.2.0

- **Permanent endpoint** — MCP endpoint is now `https://api.hederatoolbox.com/mcp`
- **Removed HITL hard-stop** — governance tools now execute directly; operator approval flow removed

## What's New in v3.1.0

- **Atomic balance deduction** — balance check and deduct now a single SQL operation, safe under any concurrency
- **HCS message sanitisation** — control characters and malformed content stripped before AI analysis
- **Robust JSON parsing** — AI responses now use a fallback parser; one bad HCS message can no longer crash the analysis tools
- **Ghost deposit fix** — zero-value staking redistribution entries no longer trigger false deposit notifications

## Known Limitations

- Mirror node balance endpoint occasionally returns empty for high-holder tokens. Metadata unaffected.

---

## Links

| | |
|---|---|
| npm | https://www.npmjs.com/package/@hederatoolbox/platform |
| MCP Registry | https://registry.modelcontextprotocol.io/?q=hederatoolbox |
| Live endpoint | https://api.hederatoolbox.com/mcp |
| Terms | https://api.hederatoolbox.com/terms |

---

## License

**npm package** — provided for integration use only.

**Remote server and all backend logic** — Proprietary. See [LICENSE.md](LICENSE.md).

Enterprise licensing and SLA inquiries: open an issue titled `[Enterprise]`.

---

## Website

[hederatoolbox.com](https://hederatoolbox.com)


