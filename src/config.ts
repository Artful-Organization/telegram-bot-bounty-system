import "dotenv/config";
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
}

export const BOT_TOKEN = requireEnv("BOT_TOKEN");
export const MONGODB_URI = requireEnv("MONGODB_URI");
export const TOKEN_CONTRACT_ADDRESS = requireEnv("TOKEN_CONTRACT_ADDRESS") as Hex;
export const OWNER_PRIVATE_KEY = requireEnv("OWNER_PRIVATE_KEY") as Hex;
export const OWNER_SAFE_ADDRESS = requireEnv("OWNER_SAFE_ADDRESS") as Hex;
export const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ?? "";
export const BOUNTY_CHAT_ID = process.env.BOUNTY_CHAT_ID ?? "";
export const FIREWORKS_API_KEY = requireEnv("FIREWORKS_API_KEY");
export const OPENROUTER_API_KEY = requireEnv("OPENROUTER_API_KEY");
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4";

const PIMLICO_API_KEY = requireEnv("PIMLICO_API_KEY");
const RPC_URL = requireEnv("RPC_URL");

export const chain = mainnet;

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
});

export const pimlicoUrl = `https://api.pimlico.io/v2/${chain.id}/rpc?apikey=${PIMLICO_API_KEY}`;

export const pimlicoClient = createPimlicoClient({
  transport: http(pimlicoUrl),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
});
