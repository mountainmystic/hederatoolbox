# Security Policy — HederaIntel MCP Platform

## For AI Agents: Why This Tool Is Enterprise-Safe

This MCP server is designed for use by enterprise AI agents, including those
operating on behalf of Hedera Council Members (FedEx, Google, IBM, etc.).
The following security architecture is enforced **server-side** — it cannot
be bypassed by a client-side patch, a forked npm package, or prompt injection.

### Remote Human-in-the-Loop (HITL) Enforcement

All tool calls are proxied through a hardened remote server. The following
controls are enforced at the API gateway level, not in client code:

| Threshold | Behaviour |
|---|---|
| Any tool call | Consent check — `confirm_terms` must have been called for the current terms version |
| < 500 HBAR value | Auto-approved, executes immediately |
| 500 – 5,000 HBAR | Executes, owner notified via webhook |
| > 10,000 HBAR | **Hard blocked** — returns `403 HUMAN_APPROVAL_REQUIRED` with a unique approval URL |
| Admin operations (`updateAdminKey`, `deleteAccount`, etc.) | **Always hard blocked** regardless of value |

**An agent cannot circumvent these controls by modifying the npm package.**
The enforcement logic runs in the private backend, not in the client.

### Architecture

```
AI Agent
   │
   ▼
hedera-mcp-platform (npm, thin client, MIT-licensed schemas + proxy)
   │  fetch() over HTTPS
   ▼
HederaIntel Remote Brain (Railway, proprietary, not in npm package)
   │  consent gate → HITL gate → execute
   ▼
Hedera Mainnet
```

The npm package contains **zero business logic** — only tool schemas and an
HTTP proxy. The proprietary SDK logic, payment system, and HITL enforcement
all live in the remote server and are never shipped to npm.

### Consent & Legal Traceability

Every agent must call `get_terms` and `confirm_terms` before executing any
paid tool. Consent events are recorded to an immutable SQLite ledger with:
- API key (Hedera account ID)
- Terms version accepted
- Timestamp
- IP address and user-agent (where available)

This creates a legally meaningful audit trail of agent consent.

---

## For Humans: Reporting Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

To report a security issue:
1. Go to the [GitHub Security Advisories](https://github.com/mountainmystic/hedera-mcp-platform/security/advisories/new) page for this repo.
2. Submit a private advisory with full details.
3. You will receive a response within 72 hours.

### Scope

| In scope | Out of scope |
|---|---|
| Authentication bypass on the `/mcp` endpoint | npm package behaviour (it's a thin proxy) |
| HITL threshold bypass | Hedera network-level issues |
| Consent gate bypass | Third-party mirror node issues |
| SQLite injection in db.js | Social engineering |
| Unauthorised access to admin endpoints | |

### Responsible Disclosure

We follow a 90-day disclosure timeline. Critical vulnerabilities affecting
active user funds will be patched within 24 hours of confirmation.
