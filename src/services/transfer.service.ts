import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Hex } from "viem";
import { publicClient, TOKEN_CONTRACT_ADDRESS } from "../config.js";
import { buildSmartAccountClient } from "./wallet.service.js";
import { User } from "../db/models/user.model.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TransferSuccess = {
  success: true;
  txHash: Hex;
  symbol: string;
  senderUsername: string | null;
  recipientTelegramId: string;
  recipientUsername: string;
};
export type TransferFailure = { success: false; error: string };
export type TransferResult = TransferSuccess | TransferFailure;

export async function getTokenBalance(walletAddress: Hex): Promise<bigint> {
  return publicClient.readContract({
    address: TOKEN_CONTRACT_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
  });
}

let _decimalsCache: number | null = null;
export async function getTokenDecimals(): Promise<number> {
  if (_decimalsCache !== null) return _decimalsCache;
  _decimalsCache = await publicClient.readContract({
    address: TOKEN_CONTRACT_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return _decimalsCache;
}

let _symbolCache: string | null = null;
export async function getTokenSymbol(): Promise<string> {
  if (_symbolCache !== null) return _symbolCache;
  _symbolCache = await publicClient.readContract({
    address: TOKEN_CONTRACT_ADDRESS,
    abi: erc20Abi,
    functionName: "symbol",
  });
  return _symbolCache;
}

export async function formatBalance(walletAddress: Hex): Promise<string> {
  const [balance, decimals, symbol] = await Promise.all([
    getTokenBalance(walletAddress),
    getTokenDecimals(),
    getTokenSymbol(),
  ]);
  return `${formatUnits(balance, decimals)} $${symbol}`;
}

export async function sendTokens(
  fromPrivateKey: Hex,
  toAddress: Hex,
  amount: bigint,
): Promise<Hex> {
  console.log(`[transfer] sending ${amount} tokens to ${toAddress}...`);
  const client = await buildSmartAccountClient(fromPrivateKey);

  console.log("[transfer] submitting UserOperation...");
  const txHash = await client.sendTransaction({
    calls: [
      {
        to: TOKEN_CONTRACT_ADDRESS,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [toAddress, amount],
        }),
      },
    ],
  });

  console.log(`[transfer] tx confirmed: ${txHash}`);
  return txHash;
}

export type ValidateTransferResult =
  | { success: true; symbol: string }
  | { success: false; error: string };

export async function validateTransfer(
  senderTelegramId: string,
  recipientUsername: string,
  amountStr: string,
): Promise<ValidateTransferResult> {
  const sender = await User.findOne({ telegramId: senderTelegramId });
  if (!sender) {
    return { success: false, error: "You don't have a wallet yet. Use /start first." };
  }

  const recipient = await User.findOne({
    username: { $regex: new RegExp(`^${escapeRegex(recipientUsername)}$`, "i") },
  });
  if (!recipient) {
    return { success: false, error: `@${recipientUsername} doesn't have a wallet. They need to /start first.` };
  }

  if (sender.telegramId === recipient.telegramId) {
    return { success: false, error: "You can't send tokens to yourself." };
  }

  const decimals = await getTokenDecimals();
  const amount = parseUnits(amountStr, decimals);
  const balance = await getTokenBalance(sender.smartAccountAddress as Hex);
  if (balance < amount) {
    const formatted = await formatBalance(sender.smartAccountAddress as Hex);
    return { success: false, error: `Insufficient balance. You have ${formatted}.` };
  }

  const symbol = await getTokenSymbol();
  return { success: true, symbol };
}

export async function performTransfer(
  senderTelegramId: string,
  recipientUsername: string,
  amountStr: string,
): Promise<TransferResult> {
  console.log(`[transfer] performTransfer: ${senderTelegramId} -> @${recipientUsername} amount=${amountStr}`);

  const sender = await User.findOne({ telegramId: senderTelegramId });
  if (!sender) {
    console.log(`[transfer] sender ${senderTelegramId} not found`);
    return { success: false, error: "You don't have a wallet yet. Use /start first." };
  }

  const recipient = await User.findOne({
    username: { $regex: new RegExp(`^${escapeRegex(recipientUsername)}$`, "i") },
  });
  if (!recipient) {
    console.log(`[transfer] recipient @${recipientUsername} not found`);
    return {
      success: false,
      error: `@${recipientUsername} doesn't have a wallet. They need to /start first.`,
    };
  }

  if (sender.telegramId === recipient.telegramId) {
    console.log("[transfer] rejected: self-transfer");
    return { success: false, error: "You can't send tokens to yourself." };
  }

  const decimals = await getTokenDecimals();
  const amount = parseUnits(amountStr, decimals);

  const balance = await getTokenBalance(sender.smartAccountAddress as Hex);
  console.log(`[transfer] sender balance: ${formatUnits(balance, decimals)}, needed: ${amountStr}`);
  if (balance < amount) {
    const formatted = await formatBalance(sender.smartAccountAddress as Hex);
    console.log(`[transfer] insufficient balance: ${formatted}`);
    return { success: false, error: `Insufficient balance. You have ${formatted}.` };
  }

  const txHash = await sendTokens(
    sender.privateKey as Hex,
    recipient.smartAccountAddress as Hex,
    amount,
  );

  await User.updateOne({ telegramId: senderTelegramId }, { isDeployed: true });

  const symbol = await getTokenSymbol();
  console.log(`[transfer] SUCCESS: ${amountStr} $${symbol} from @${sender.username} to @${recipient.username} tx=${txHash}`);
  return {
    success: true,
    txHash,
    symbol,
    senderUsername: sender.username ?? null,
    recipientTelegramId: recipient.telegramId,
    recipientUsername: recipient.username ?? recipientUsername,
  };
}
