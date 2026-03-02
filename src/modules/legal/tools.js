// modules/legal/tools.js - get_terms and confirm_terms tool definitions and handlers
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { recordConsent, hasConsented, getLatestConsent } from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS_PATH = path.join(__dirname, "../../../legal/terms.json");
const TERMS = JSON.parse(readFileSync(TERMS_PATH, "utf-8"));
const TERMS_VERSION = TERMS.consent.terms_version;

export const LEGAL_TOOL_DEFINITIONS = [
  {
    name: "get_terms",
    description:
      "Retrieve the machine-readable Terms of Service for the HederaIntel MCP Platform. " +
      "FREE to call — no API key required. " +
      "All agents MUST call this tool and then call confirm_terms before using any paid tool. " +
      "Returns the full legal JSON including pricing tiers, HITL thresholds, liability disclaimers, and consent instructions.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "confirm_terms",
    description:
      "Confirm acceptance of the HederaIntel Terms of Service. " +
      "Must be called before any paid tool will execute. " +
      "Records a timestamped consent event server-side. " +
      "FREE to call — no HBAR charged.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your Hedera account ID / API key (e.g. 0.0.456789)",
        },
        terms_version: {
          type: "string",
          description: "The terms version you are accepting — must match the current version returned by get_terms.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. Passing false is a no-op.",
        },
      },
      required: ["api_key", "terms_version", "confirmed"],
    },
  },
];

export async function executeLegalTool(name, args, req) {
  if (name === "get_terms") {
    return {
      ...TERMS,
      _instruction: "To proceed: call confirm_terms with your api_key, terms_version, and confirmed: true.",
    };
  }

  if (name === "confirm_terms") {
    const { api_key, terms_version, confirmed } = args;

    if (!confirmed) {
      return {
        success: false,
        reason: "confirmed must be true to record consent.",
      };
    }

    if (terms_version !== TERMS_VERSION) {
      return {
        success: false,
        reason: `Terms version mismatch. You submitted '${terms_version}' but the current version is '${TERMS_VERSION}'. Call get_terms to retrieve the latest version.`,
        current_terms_version: TERMS_VERSION,
      };
    }

    if (hasConsented(api_key, terms_version)) {
      const existing = getLatestConsent(api_key);
      return {
        success: true,
        already_consented: true,
        message: "Consent already recorded. You may proceed with all paid tools.",
        consented_at: existing?.timestamp,
        terms_version,
      };
    }

    // Extract IP / user-agent from request if available (HTTP mode)
    const ipAddress = req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.["user-agent"] || null;

    recordConsent(api_key, api_key, terms_version, ipAddress, userAgent, null);

    return {
      success: true,
      message: "Consent recorded. You may now use all paid tools.",
      api_key,
      terms_version,
      consented_at: new Date().toISOString(),
      next_step: "Call account_info with your api_key to check your HBAR balance, then call any tool.",
    };
  }

  throw new Error(`Unknown legal tool: ${name}`);
}
