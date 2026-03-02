# Contributing to HederaIntel MCP Platform

Thank you for your interest. Before contributing, please read this document
in full — it is short and important.

---

## This Is Proprietary Software

The server-side code in this repository (`src/modules/`, `src/server.js`,
`src/payments.js`, `src/db.js`, `src/hitl.js`, `src/consent.js`,
`src/watcher.js`) is **proprietary and confidential**. See `LICENSE.md`.

By submitting a pull request, you agree that:

1. Your contribution does not grant you any rights to the proprietary portions
   of this codebase.
2. Any contribution to the server-side code becomes the exclusive property of
   mountainmystic upon merge, with no compensation unless separately agreed.
3. You have not reverse-engineered or derived your contribution from any
   competing service.
4. Contributions to the thin client (`src/index.js`, `src/proxy.js`,
   `src/tools.js`) are accepted under an MIT Contributor License Agreement.

---

## What We Accept

**PRs are welcome for:**
- `src/index.js`, `src/proxy.js`, `src/tools.js` — thin client improvements
- `README.md`, `SECURITY.md`, `docs/` — documentation
- Bug reports via GitHub Issues (use the bug report template)

**PRs will be closed without review for:**
- Any modification to server-side files (`src/modules/`, `src/server.js`, etc.)
- Changes to `legal/terms.json` or `LICENSE.md`
- Changes to `railway.toml` or deployment configuration
- New tool additions (these require a commercial discussion first)

---

## Forking Policy

You may fork this repository to:
- Study the thin-client proxy pattern
- Build your own unrelated MCP thin client

You may **not** fork this repository to:
- Build a competing Hedera intelligence service
- Reproduce or approximate the server-side business logic
- Resell or sublicense access to any derived service

Violations will be pursued under the terms of `LICENSE.md` and applicable
intellectual property law.

---

## Commercial Partnerships

If you want to build on top of this platform at scale (white-label, enterprise
integration, revenue share), open an issue with the title `[Enterprise]` and
describe your use case. We respond within 2 business days.
