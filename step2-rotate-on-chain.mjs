// step2-rotate-on-chain.mjs
import { Client, PrivateKey, PublicKey, AccountUpdateTransaction } from "@hashgraph/sdk";

const OPERATOR_ID     = "0.0.10298356";
const OLD_PRIVATE_KEY = "2a03a9d23cab58ccd78544d3f703b3a043f38eca4c10a48004e8a6ea8eb45925";
const NEW_PUBLIC_KEY  = "302d300706052b8104000a032200028a2db307eff3ac1ebca6aee52819a9391108d0d44dc2e574ad6a459632ed1c6f";

async function rotateOnChain() {
  const oldKey = PrivateKey.fromStringECDSA(OLD_PRIVATE_KEY);
  const newPubKey = PublicKey.fromString(NEW_PUBLIC_KEY);

  const client = Client.forMainnet().setOperator(OPERATOR_ID, oldKey);

  console.log("Submitting CryptoUpdate to Hedera mainnet...");

  const tx = await new AccountUpdateTransaction()
    .setAccountId(OPERATOR_ID)
    .setKey(newPubKey)
    .freezeWith(client)
    .sign(oldKey);

  const response = await tx.execute(client);
  const receipt  = await response.getReceipt(client);

  console.log("Transaction status:", receipt.status.toString());

  if (receipt.status.toString() === "SUCCESS") {
    console.log("✅ Key rotation complete. Old key is now invalid on-chain.");
    console.log("Next: update HEDERA_PRIVATE_KEY in Railway with your new private key.");
  } else {
    console.log("❌ Something went wrong. Status:", receipt.status.toString());
  }

  client.close();
}

rotateOnChain().catch(console.error);