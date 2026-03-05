// backup.mjs — Nightly SQLite backup to private GitHub repo
// Reads the DB file directly from the Railway volume — no HTTP call needed.
import https from "https";
import { readFileSync } from "fs";

console.log("=== HederaIntel Backup Script Starting ===");
console.log("Time:", new Date().toISOString());

const REQUIRED = ["GITHUB_BACKUP_TOKEN", "GITHUB_BACKUP_REPO"];
for (const key of REQUIRED) {
  console.log(`${key}: ${process.env[key] ? "SET" : "MISSING"}`);
}

const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("❌ Missing env vars: " + missing.join(", "));
  process.exit(1);
}

const GITHUB_TOKEN    = process.env.GITHUB_BACKUP_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_BACKUP_REPO;
const DB_PATH         = process.env.DB_PATH || "/data/hederaintel.db";
const TODAY           = new Date().toISOString().slice(0, 10);
const BACKUP_FILENAME = `backups/hederaintel-${TODAY}.db`;

console.log("DB path:", DB_PATH);
console.log("GitHub Repo:", GITHUB_REPO);
console.log("Backup filename:", BACKUP_FILENAME);

// ─────────────────────────────────────────────
// Step 1 — Read the DB file directly from volume
// ─────────────────────────────────────────────

console.log("\nStep 1: Reading DB file from volume...");
let dbBuffer;
try {
  dbBuffer = readFileSync(DB_PATH);
  console.log(`✅ Read ${(dbBuffer.length / 1024).toFixed(1)} KB from ${DB_PATH}`);
} catch (e) {
  console.error("❌ Could not read DB file:", e.message);
  console.error("Hint: Make sure the Railway volume is mounted to this service too");
  process.exit(1);
}

// ─────────────────────────────────────────────
// Step 2 — Check if file already exists in GitHub
// ─────────────────────────────────────────────

async function getExistingSha(filename) {
  console.log(`\nStep 2: Checking if ${filename} exists in GitHub...`);
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/${filename}`,
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "hederaintel-backup",
        "Accept": "application/vnd.github+json",
      },
    };
    const req = https.request(options, (res) => {
      console.log("GitHub check status:", res.statusCode);
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).sha); } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", (e) => { console.error("GitHub check error:", e.message); resolve(null); });
    req.end();
  });
}

// ─────────────────────────────────────────────
// Step 3 — Commit the DB file to GitHub
// ─────────────────────────────────────────────

async function commitToGitHub(fileBuffer, existingSha) {
  console.log(`\nStep 3: Committing to GitHub (${(fileBuffer.length / 1024).toFixed(1)} KB)...`);
  const body = JSON.stringify({
    message: `chore: nightly backup ${TODAY}`,
    content: fileBuffer.toString("base64"),
    ...(existingSha ? { sha: existingSha } : {}),
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/${BACKUP_FILENAME}`,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "hederaintel-backup",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      console.log("GitHub commit status:", res.statusCode);
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(JSON.parse(data));
        } else {
          console.error("GitHub response:", data);
          reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
      });
    });
    req.on("error", (e) => { console.error("GitHub commit error:", e.message); reject(e); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

try {
  const existingSha = await getExistingSha(BACKUP_FILENAME);
  if (existingSha) console.log("File exists in repo — will update");
  else console.log("New file — will create");

  await commitToGitHub(dbBuffer, existingSha);
  console.log(`✅ Backup committed to ${GITHUB_REPO}/${BACKUP_FILENAME}`);
  process.exit(0);
} catch (err) {
  console.error("❌ Backup failed:", err.message);
  process.exit(1);
}
