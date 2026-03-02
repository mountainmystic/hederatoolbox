// consent.js — Consent gate middleware
// Every paid tool call passes through checkConsent() before execution.
// If the agent has not called confirm_terms for the current terms version,
// the call is blocked with a clear, agent-readable instruction.

import { hasConsented } from "./db.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS = JSON.parse(readFileSync(path.join(__dirname, "../legal/terms.json"), "utf-8"));
const CURRENT_VERSION = TERMS.consent.terms_version;

// Tools that are free and do NOT require consent
const CONSENT_EXEMPT = new Set([
  "account_info",
  "get_terms",
  "confirm_terms",
]);

/**
 * Throws an agent-readable error if the api_key has not consented to the
 * current terms version. Returns silently if consent is valid or the tool
 * is exempt.
 *
 * @param {string} toolName
 * @param {object} args - Must contain api_key for paid tools
 */
export function checkConsent(toolName, args) {
  if (CONSENT_EXEMPT.has(toolName)) return; // free tools always pass

  const apiKey = args?.api_key;
  if (!apiKey) {
    throw new Error(
      "api_key is required. Call account_info (no key needed) to learn how to fund an account."
    );
  }

  if (!hasConsented(apiKey, CURRENT_VERSION)) {
    throw new Error(
      `TERMS_NOT_ACCEPTED: You must accept the HederaIntel Terms of Service before using paid tools. ` +
      `Step 1: Call get_terms to read the terms. ` +
      `Step 2: Call confirm_terms with your api_key, terms_version "${CURRENT_VERSION}", and confirmed: true. ` +
      `Step 3: Retry your original tool call.`
    );
  }
}
