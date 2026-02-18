import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { toSafeSmartAccount } from "permissionless/accounts";

const privateKey = process.env.OWNER_PRIVATE_KEY;
if (!privateKey) throw new Error("Missing OWNER_PRIVATE_KEY in .env");

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("Missing RPC_URL in .env");

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl),
});

const signer = privateKeyToAccount(privateKey as `0x${string}`);

console.log("EOA address:", signer.address);
console.log("Computing Safe counterfactual address...");

const safe = await toSafeSmartAccount({
  client: publicClient,
  owners: [signer],
  entryPoint: { address: entryPoint07Address, version: "0.7" },
  version: "1.5.0",
});

console.log("Owner Safe address:", safe.address);
console.log("");
console.log("Add this to your .env:");
console.log(`OWNER_SAFE_ADDRESS=${safe.address}`);
