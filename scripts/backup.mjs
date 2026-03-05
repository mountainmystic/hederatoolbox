// backup.mjs — Nightly SQLite backup to private GitHub repo
// Runs as a Railway cron job. Fetches the live DB via /admin/backup,
// then commits it to the hederaintel-backups GitHub repo.

import https from "https";

const REQUIRED = ["ADMIN_SECRET", "GITHUB_BACKUP_TOKEN", "GITHUB_BACKUP_REPO", "RAILWAY_PUBLIC_DOMAIN"];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}

const ADMIN_SECRET        = process.env.ADMIN_SECRET;
const GITHUB_TOKEN        = process.env.GITHUB_BACKUP_TOKEN;
const GITHUB_REPO         = process.env.GITHUB_BACKUP_REPO;       // e.g. mountainmystic/hederaintel-backups
const PLATFORM_URL        = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const TODAY               = new Date().toISOString().slice(0, 10); // e.g. 2026-03-06
const BACKUP_FILENAME     = `backups/hederaintel-${TODAY}.db`;

// ─────────────────────────────────────────────
// Step 1 — Fetch the live DB from /admin/backup
// ─────────────────────────────────────────────

async function fetchBackup() {
  console.log(`Fetching backup from ${PLATFORM_URL}/admin/backup ...`);
  return new Promise((resolve, reject) => {
    const req = https.request(`${PLATFORM_URL}/admin/backup`, {
      headers: { "x-admin-secret": ADMIN_SECRET },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Backup endpoint returned ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ─────────────────────────────────────────────
// Step 2 — Check if file already exists in GitHub (need SHA to update)
// ─────────────────────────────────────────────

async function getExistingSha(filename) {
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
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).sha); } catch { resolve(null); }
        } else {
          resolve(null); // file doesn't exist yet — that's fine
        }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ─────────────────────────────────────────────
// Step 3 — Commit the DB file to GitHub
// ─────────────────────────────────────────────

async function commitToGitHub(fileBuffer, existingSha) {
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
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

try {
  const dbBuffer = await fetchBackup();
  console.log(`Fetched ${(dbBuffer.length / 1024).toFixed(1)} KB`);

  const existingSha = await getExistingSha(BACKUP_FILENAME);
  if (existingSha) console.log("File exists in repo — will update");

  await commitToGitHub(dbBuffer, existingSha);
  console.log(`✅ Backup committed to ${GITHUB_REPO}/${BACKUP_FILENAME}`);
  process.exit(0);
} catch (err) {
  console.error("❌ Backup failed:", err.message);
  process.exit(1);
}
