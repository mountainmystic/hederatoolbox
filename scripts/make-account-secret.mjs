// make-account-secret.mjs — generate an api_secret for a protected account.
//
// Usage (from the repo root):
//   node scripts/make-account-secret.mjs 0.0.10435510
//
// Prints two things:
//   SECRET  → goes ONLY into the calling service's env (e.g. TOOLBOX_API_SECRET
//             on Fixatum or TheRecordKeeper). Never commit it, never paste it in chat.
//   ENTRY   → goes into Toolbox's PROTECTED_ACCOUNTS env var. It holds the
//             SHA-256 hash, not the secret, so it is safe if Railway env leaks.
//
// Join several entries with commas:
//   PROTECTED_ACCOUNTS=0.0.111:<hash>,0.0.222:<hash>

import { randomBytes, createHash } from "node:crypto";

const account = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(account || "")) {
  console.error("Usage: node scripts/make-account-secret.mjs 0.0.XXXXXX");
  process.exit(1);
}

const secret = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(secret, "utf8").digest("hex");

console.log(`\nAccount: ${account}`);
console.log(`SECRET (caller env only):          ${secret}`);
console.log(`ENTRY  (Toolbox PROTECTED_ACCOUNTS): ${account}:${hash}\n`);
