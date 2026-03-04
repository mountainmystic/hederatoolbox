// step1-generate-key.js
// Run this FIRST. Just generates and prints a new key pair. Nothing is changed on-chain yet.

const { PrivateKey } = require("@hashgraph/sdk");

const newPrivateKey = PrivateKey.generateECDSA();

console.log("========================================");
console.log("NEW PRIVATE KEY:", newPrivateKey.toString());
console.log("NEW PUBLIC KEY: ", newPrivateKey.publicKey.toString());
console.log("========================================");
console.log("⚠️  Copy both of these somewhere safe NOW before continuing.");