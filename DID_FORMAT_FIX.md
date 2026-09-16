# HederaToolbox — Fix: parseAgentDid rejects every real Fixatum DID

Drafted by Midas, 2026-09-10. **This is the HederaToolbox repo** (`G:\Ai Work\MCP-Portfolio\hedera-mcp-platform\`),
not TheRecordKeeper's — a different product, live for every Toolbox customer, not just this side
project. Treat this as its own GO, separate from anything TheRecordKeeper-related.

## What's actually wrong

`src/did.js`'s `parseAgentDid()` requires a 34-byte decoded key (2-byte `0xed01` multicodec prefix
+ 32-byte raw Ed25519 key) or it throws. Checked directly against Fixatum's live `src/register.js`
(`validatePublicKey`) and `src/server.js` (`/keygen` endpoint, `crypto.generateKeyPairSync('ed25519')`
+ raw base58 encode, no prefix) — Fixatum has never produced, and does not today produce, a
multicodec-prefixed key. It always issues a bare 32-byte key. Confirmed by independently decoding
four DIDs spanning the full registration history (first-ever DID, the Fixatum platform's own DID,
Midas's DID, TheRecordKeeper's DID) — all four are 32 bytes, none carry the prefix.

Net effect: `verifyAgentSignature()` — and therefore the entire agent-signed HCS records feature
shipped 2026-09-02 for the Apex judges — cannot succeed for any agent that has registered, or
could register, through Fixatum's actual live registration flow. This was never exercised
end-to-end before TheRecordKeeper's redeploy work surfaced it tonight.

## The fix — `src/did.js`, `parseAgentDid()`

Accept the format Fixatum actually issues (32-byte raw key) as the primary case. Keep accepting
the 34-byte multicodec-prefixed form too, in case anything ever produces it — this is additive,
not a breaking change to the DID string format itself (no existing DID changes at all, only how
the verifier reads the key out of it).

```js
// Parse a Fixatum DID into its parts and recover the raw Ed25519 public key.
// Throws with a specific reason so the caller can hand it straight to the agent.
export function parseAgentDid(did) {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX)) {
    throw new Error(`agent_did must start with "${DID_PREFIX}"`);
  }

  const body = did.slice(DID_PREFIX.length);
  const sep = body.lastIndexOf("_");
  if (sep === -1) {
    throw new Error("agent_did must be in the form did:hedera:mainnet:z{BASE58_PUBKEY}_{ACCOUNT_ID}");
  }

  const multibase = body.slice(0, sep);
  const accountId = body.slice(sep + 1);

  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    throw new Error(`agent_did account segment "${accountId}" is not a Hedera account ID (expected 0.0.123456)`);
  }
  if (!multibase.startsWith("z")) {
    throw new Error("agent_did key segment must be base58btc multibase and start with z");
  }

  const decoded = base58Decode(multibase.slice(1));

  // Fixatum's live /keygen and validatePublicKey (register.js, server.js — checked
  // directly 2026-09-10) issue and accept a BARE 32-byte raw Ed25519 public key, no
  // multicodec wrapper. Every DID registered to date is in this form — treat it as
  // the real, primary case. Also accept the W3C-style multicodec-prefixed 34-byte
  // form (0xed01 + 32 bytes) for forward-compatibility, in case a future key
  // generator ever produces it — not a format in live use today.
  let rawPublicKey;
  if (decoded.length === ED25519_PUBLIC_KEY_BYTES) {
    rawPublicKey = decoded;
  } else if (
    decoded.length === ED25519_MULTICODEC_PREFIX.length + ED25519_PUBLIC_KEY_BYTES &&
    decoded[0] === ED25519_MULTICODEC_PREFIX[0] &&
    decoded[1] === ED25519_MULTICODEC_PREFIX[1]
  ) {
    rawPublicKey = decoded.subarray(ED25519_MULTICODEC_PREFIX.length);
  } else {
    throw new Error(
      `agent_did key decodes to ${decoded.length} bytes — expected ${ED25519_PUBLIC_KEY_BYTES} ` +
      `(Fixatum's raw format) or ${ED25519_MULTICODEC_PREFIX.length + ED25519_PUBLIC_KEY_BYTES} ` +
      `with an 0xed01 multicodec prefix`
    );
  }

  return { multibase, accountId, rawPublicKey };
}
```

Nothing else in `did.js` needs to change — `verifyAgentSignature()` just destructures
`rawPublicKey` from this function's return value and doesn't care how it got there.

## Before considering this done

1. **Grep the rest of the Toolbox repo** for any other place that assumes a 34-byte / prefixed
   key (e.g. `compliance/tools.js` where `hcs_write_record`/`hcs_verify_record` call into this).
   I haven't read those files this session, so I can't rule out a second assumption living there —
   worth Claude Code CLI checking before calling this complete.
2. **This is live production code for every Toolbox customer**, not just TheRecordKeeper. Test
   after deploying: a real `hcs_write_record` call with a correctly-signed `agent_did`/`agent_signature`
   pair for an already-registered DID should now return `attestation_type: "agent_signed"` instead
   of erroring. (TheRecordKeeper's own `HEDERA_PRIVATE_KEY`, once verified via `verify-key.js` in
   its own repo, is a natural test case once this is live.)
3. **Deploy is the same Toolbox flow as always** — `git add -A && git commit && git push`, Railway
   auto-deploys `hedera-mcp-platform` from master. Smoke-test per the fixatum-toolbox skill's
   deploy checklist (§13: check `/` for a fresh `uptime_seconds`, confirm `tools/list` serves the
   updated schema — a version bump alone doesn't prove the new code path is live).

**This needs its own explicit GO before it touches master/Railway** — it's a correctness fix to
the real paid product's signature verification, not a TheRecordKeeper-side change, and Hard Rule 1
treats it accordingly regardless of how contained the diff looks.
