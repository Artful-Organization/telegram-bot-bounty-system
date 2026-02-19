import { http, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createSmartAccountClient } from "permissionless";
import { publicClient, pimlicoClient, pimlicoUrl, chain } from "../config.js";

export async function createWallet() {
  console.log("[wallet] generating new wallet...");
  const privKey = generatePrivateKey();
  const signer = privateKeyToAccount(privKey);

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [signer],
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
    version: "1.5.0",
  });

  console.log(`[wallet] created safe account: ${safeAccount.address}`);
  return { address: safeAccount.address, privateKey: privKey };
}

export async function buildSmartAccountClient(privateKey: Hex) {
  console.log("[wallet] building smart account client...");
  const signer = privateKeyToAccount(privateKey);

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [signer],
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
    version: "1.5.0",
  });

  console.log(`[wallet] smart account ready: ${safeAccount.address}`);
  return createSmartAccountClient({
    account: safeAccount,
    chain,
    bundlerTransport: http(pimlicoUrl),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });
}
