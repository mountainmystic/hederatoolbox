import { PrivateKey } from "@hashgraph/sdk";

const newPrivateKey = PrivateKey.generateECDSA();

console.log("========================================");
console.log("NEW PRIVATE KEY:", newPrivateKey.toString());
console.log("NEW PUBLIC KEY: ", newPrivateKey.publicKey.toString());
console.log("========================================");
console.log("Copy both of these somewhere safe NOW.");