// did.js - Fixatum DID parsing and Ed25519 signature checks.
//
// DID format: did:hedera:mainnet:z{BASE58BTC_MULTIBASE}_{HEDERA_ACCOUNT_ID}
// The multibase segment decodes to the multicodec ed25519-pub prefix (0xed 0x01)
// followed by the 32-byte raw public key. The public key travels inside the DID
// itself, so no network lookup is needed to check a signature.
//
// Ed25519 verification reuses @hashgraph/sdk (already a direct dependency) —
// no second crypto library is introduced.

import { PublicKey } from "@hashgraph/sdk";

const DID_PREFIX = "did:hedera:mainnet:";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
const ED25519_MULTICODEC_PREFIX = [0xed, 0x01];
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

// Decode a base58btc string to bytes. Throws on any character outside the
// alphabet — base58 deliberately omits 0, O, I and l.
export function base58Decode(str) {
  if (typeof str !== "string" || str.length === 0) {
    throw new Error("base58 input must be a non-empty string");
  }
  const bytes = [0];
  for (const ch of str) {
    const value = BASE58_MAP.get(ch);
    if (value === undefined) throw new Error(`invalid base58 character "${ch}"`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" encodes one leading zero byte.
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

// Parse a Fixatum DID into its parts and recover the raw Ed25519 public key.
// Throws with a specific reason so the caller can hand it straight to the agent.
export function parseAgentDid(did) {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX)) {
    throw new Error(`agent_did must start with "${DID_PREFIX}"`);
  }

  const body = did.slice(DID_PREFIX.length);
  // Hedera account IDs contain dots and base58 contains neither "_" nor ".",
  // so the last underscore is an unambiguous separator.
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
  // directly 2026-09-10, DID_FORMAT_FIX.md) issue and accept a BARE 32-byte raw
  // Ed25519 public key, no multicodec wrapper. Every DID registered to date is in
  // this form — treat it as the real, primary case. Also accept the W3C-style
  // multicodec-prefixed 34-byte form (0xed01 + 32 bytes) for forward-compatibility,
  // in case a future key generator ever produces it — not a format in live use today.
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

// Recursively sort object keys at every depth. Arrays keep their order — order
// is meaningful in a list — but their elements are canonicalised too.
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalise(value[key]);
    return sorted;
  }
  return value;
}

// Deterministic JSON for signing and checking. Two structurally identical
// payloads always produce the same string regardless of how they were built.
export function canonicalPayload(value) {
  return JSON.stringify(canonicalise(value));
}

// Check a base64 Ed25519 signature over canonicalPayload(payload) against the
// public key carried in the DID. Returns a boolean; throws if the DID or the
// signature is malformed.
//
// A true result means the holder of that DID's private key signed this exact
// payload. It says nothing about who owns the DID — that is a separate lookup.
export function verifyAgentSignature(did, payload, signatureB64) {
  const { rawPublicKey } = parseAgentDid(did);

  if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
    throw new Error("agent_signature must be a base64 string");
  }
  const signature = Buffer.from(signatureB64, "base64");
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error(`agent_signature must decode to ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  }

  const message = Buffer.from(canonicalPayload(payload), "utf-8");
  return PublicKey.fromBytesED25519(rawPublicKey).verify(message, signature);
}

// The envelope an agent signs. Binding the record metadata and topic into the
// signed bytes stops a signature being lifted onto a different record or topic.
export function attestationEnvelope({ topic_id, record_type, entity_id, data }) {
  return { topic_id, record_type, entity_id, data };
}
