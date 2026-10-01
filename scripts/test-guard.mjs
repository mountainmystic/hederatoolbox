// Phase 1 guard tests. Run from repo root: node --experimental-sqlite scripts/test-guard.mjs
// Uses a throwaway DB in /tmp (or %TEMP%); never touches hederaintel.db.
import { createHash } from "node:crypto";
import fs from "node:fs";
const DB = (await import("node:path")).join((await import("node:os")).tmpdir(), "guard-test.db"); try { fs.unlinkSync(DB); } catch {}
const SECRET = "test-secret-abc123";
const H = createHash("sha256").update(SECRET).digest("hex");
process.env.DB_PATH = DB;
process.env.PROTECTED_ACCOUNTS = `0.0.10435510:${H},0.0.10419731:${H},garbage:entry`;
process.env.BREAKER_MODE = "enforce";
process.env.HEDERA_NETWORK = "testnet";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../src/server.js");
const dbm = await import("../src/db.js");
const { didBelongsToKey, stripSecret } = await import("../src/guard.js");
const terms = JSON.parse(fs.readFileSync(new URL("../legal/terms.json", import.meta.url),"utf8")).consent.terms_version;

for (const k of ["0.0.10435510","0.0.10419731","0.0.555","0.0.777"]) {
  dbm.provisionKey(k, 50_0000_0000, k);
  dbm.recordConsent(k, k, terms, "1.1.1.1", "test", null);
}
const [a,b] = InMemoryTransport.createLinkedPair();
const server = createServer(); await server.connect(a);
const client = new Client({ name: "t", version: "1" }); await client.connect(b);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text }; };
let pass = 0, fail = 0;
const check = (label, ok, detail="") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + detail}`); };

let r;
r = await call("account_info", { api_key: "0.0.10435510" });
check("protected key, no secret → refused", r.err && r.text.includes("api_secret"), r.text);
r = await call("account_info", { api_key: "0.0.10435510", api_secret: "wrong" });
check("protected key, wrong secret → refused", r.err && r.text.includes("api_secret"), r.text);
r = await call("account_info", { api_key: "0.0.10435510", api_secret: SECRET });
check("protected key, right secret → works", !r.err && !r.text.includes(SECRET), r.text.slice(0,200));
r = await call("token_price", { api_key: "0.0.10419731", token_id: "0.0.1" });
check("protected key on paid tool, no secret → refused", r.err && r.text.includes("api_secret"), r.text);
r = await call("fixatum_fleet_status", { api_key: "0.0.555" });
check("fleet tool, ordinary key → refused", r.err && r.text.includes("platform operator"), r.text);
r = await call("fixatum_fleet_status", { api_key: "0.0.10435510" });
check("fleet tool, operator key no secret → refused", r.err, r.text);
r = await call("fixatum_fleet_status", { api_key: "0.0.10435510", api_secret: SECRET });
check("fleet tool, operator + secret → passes guard", !r.text.includes("platform operator") && !r.text.includes("api_secret"), r.text.slice(0,200));
const tl = await client.listTools();
const fleet = tl.tools.filter(t => t.name.startsWith("fixatum_fleet"));
check("fleet descriptions don't leak operator ID", fleet.every(t => !JSON.stringify(t).includes("10435510") && !JSON.stringify(t).includes("Midas")), JSON.stringify(fleet).slice(0,200));

// breaker: seed 8 distinct paid tools in the last hour for 0.0.777
const ins = dbm.db.prepare("INSERT INTO transactions (api_key, tool_name, amount_tinybars) VALUES (?, ?, ?)");
for (const t of ["hcs_monitor","hcs_query","token_price","token_monitor","identity_resolve","contract_read","governance_monitor","identity_verify_kyc"]) ins.run("0.0.777", t, 1);
r = await call("token_analyze", { api_key: "0.0.777", token_id: "0.0.1" });
check("breaker enforce: 9th distinct tool in 1h → frozen", r.err && r.text.includes("paused"), r.text);
r = await call("token_price", { api_key: "0.0.777", token_id: "0.0.1" });
check("breaker: frozen key stays paused", r.err && r.text.includes("paused until"), r.text);
const fr = dbm.db.prepare("SELECT * FROM spend_freezes").all();
check("breaker: freeze row written", fr.length === 1 && fr[0].api_key === "0.0.777", JSON.stringify(fr));
// alert mode lets it through
process.env.BREAKER_MODE = "alert";
dbm.db.exec("DELETE FROM spend_freezes");
r = await call("token_analyze", { api_key: "0.0.777", token_id: "0.0.1" });
check("breaker alert mode: not blocked", !r.text.includes("paused"), r.text.slice(0,200));
process.env.BREAKER_MODE = "enforce";
// ordinary low-volume key unaffected
r = await call("token_price", { api_key: "0.0.555", token_id: "0.0.1" });
check("ordinary key, low volume → not blocked by guard", !r.text.includes("paused") && !r.text.includes("api_secret"), r.text.slice(0,200));

check("didBelongsToKey: own DID", didBelongsToKey("did:hedera:mainnet:zABC_0.0.555","0.0.555"));
check("didBelongsToKey: other DID rejected", !didBelongsToKey("did:hedera:mainnet:zABC_0.0.10435510","0.0.555"));
check("didBelongsToKey: suffix trick rejected", !didBelongsToKey("did:hedera:mainnet:zABC_0.0.1555","0.0.555"));
check("stripSecret removes api_secret", !("api_secret" in stripSecret({api_key:"x",api_secret:"y",z:1})));
// provenance never contains the secret
await new Promise(r => setTimeout(r, 300));
const prov = dbm.db.prepare("SELECT * FROM provenance").all();
check("no secret in provenance rows", !JSON.stringify(prov).includes(SECRET), "leak");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
