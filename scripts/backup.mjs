// backup.mjs — Nightly SQLite backup to private GitHub repo
// Fetches the live DB via /admin/backup then commits to GitHub.
import https from "https";
import http from "http";
import { lookup } from "dns";

console.log("=== HederaIntel Backup Script Starting ===");
console.log("Time:", new Date().toISOString());

const REQUIRED = ["ADMIN_SECRET", "GITHUB_BACKUP_TOKEN", "GITHUB_BACKUP_REPO", "RAILWAY_PUBLIC_DOMAIN"];
for (const key of REQUIRED) {
  console.log(`${key}: ${process.env[key] ? "SET" : "MISSING"}`);
}

const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("❌ Missing env vars: " + missing.join(", "));
  process.exit(1);
}

const ADMIN_SECRET    = process.env.ADMIN_SECRET;
const GITHUB_TOKEN    = process.env.GITHUB_BACKUP_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_BACKUP_REPO;
// Use Railway private domain for inter-service calls
// We reference the main service's private domain via a variable we set manually
const PLATFORM_URL    = `http://${process.env.MAIN_SERVICE_PRIVATE_DOMAIN}`;
const TODAY           = new Date().toISOString().slice(0, 10);
const BACKUP_FILENAME = `backups/hederaintel-${TODAY}.db`;

console.log("Platform URL:", PLATFORM_URL);

// Quick DNS check
await new Promise(resolve => {
  lookup("hedera-mcp-platform.railway.internal", (err, address) => {
    if (err) console.error("DNS lookup failed:", err.message);
    else console.log("DNS resolved to:", address);
    resolve();
  });
});
console.log("GitHub Repo:", GITHUB_REPO);
console.log("Backup filename:", BACKUP_FILENAME);

// ─────────────────────────────────────────────
// Step 1 — Fetch the live DB from /admin/backup
// ─────────────────────────────────────────────

async function fetchBackup() {
  console.log(`\nStep 1: Fetching backup from ${PLATFORM_URL}/admin/backup ...`);
  return new Promise((resolve, reject) => {
    const req = http.request(`${PLATFORM_URL}/admin/backup`, {
      headers: { "x-admin-secret": ADMIN_SECRET },
      timeout: 30000,
    }, (res) => {
      console.log("Backup endpoint status:", res.statusCode);
      if (res.statusCode !== 200) {
        let errData = "";
        res.on("data", chunk => errData += chunk);
        res.on("end", () => {
          console.error("Error response body:", errData);
          reject(new Error(`Backup endpoint returned ${res.statusCode}`));
        });
        return;
      }
      const chunks = [];
      res.on("data", chunk => {
        chunks.push(chunk);
        process.stdout.write(".");
      });
      res.on("end", () => {
        console.log("\nDownload complete");
        resolve(Buffer.concat(chunks));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      console.error("❌ Request timed out after 30s — is the platform URL reachable?");
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", (e) => {
      console.error("❌ Request error:", e.message);
      reject(e);
    });
    req.end();
  });
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
  const dbBuffer = await fetchBackup();
  console.log(`✅ Fetched ${(dbBuffer.length / 1024).toFixed(1)} KB`);

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
