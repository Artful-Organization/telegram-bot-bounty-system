import crypto from "node:crypto";
import { parseUnits, type Hex } from "viem";
import { Bounty } from "../db/models/bounty.model.js";
import { User } from "../db/models/user.model.js";
import {
  getTokenBalance,
  getTokenDecimals,
  getTokenSymbol,
  formatBalance,
  sendTokens,
} from "./transfer.service.js";

function generateShortId(): string {
  return crypto.randomBytes(3).toString("hex");
}

export async function createBounty(
  creatorTelegramId: string,
  description: string,
  amount: string,
) {
  let shortId = generateShortId();
  while (await Bounty.exists({ shortId })) {
    shortId = generateShortId();
  }

  return Bounty.create({
    shortId,
    creatorTelegramId,
    description,
    amount,
  });
}

export async function listOpenBounties(search?: string) {
  const filter: Record<string, unknown> = { status: "open" };

  if (search) {
    const regex = new RegExp(search, "i");
    const matchingUsers = await User.find({
      $or: [{ username: regex }, { displayName: regex }],
    }).select("telegramId").lean();
    const telegramIds = matchingUsers.map((u) => u.telegramId);

    filter.$or = [
      { description: regex },
      { creatorTelegramId: { $in: telegramIds } },
    ];
  }

  return Bounty.find(filter).sort({ createdAt: -1 });
}

export type ClaimResult =
  | { success: true }
  | { success: false; error: string };

export async function claimBounty(
  shortId: string,
  claimerTelegramId: string,
): Promise<ClaimResult> {
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) return { success: false, error: "Bounty not found." };
  if (bounty.status !== "open")
    return { success: false, error: "This bounty is not open for claims." };
  if (bounty.creatorTelegramId === claimerTelegramId)
    return { success: false, error: "You can't claim your own bounty." };

  const claimer = await User.findOne({ telegramId: claimerTelegramId });
  if (!claimer)
    return { success: false, error: "You don't have a wallet yet. Use /start first." };

  await Bounty.updateOne(
    { shortId },
    { status: "claimed", claimerTelegramId },
  );
  return { success: true };
}

export type ConfirmResult =
  | { success: true; txHash: Hex; symbol: string }
  | { success: false; error: string };

export async function confirmBounty(shortId: string): Promise<ConfirmResult> {
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) return { success: false, error: "Bounty not found." };
  if (bounty.status !== "claimed")
    return { success: false, error: "This bounty has no pending claim." };

  const creator = await User.findOne({ telegramId: bounty.creatorTelegramId });
  const claimer = await User.findOne({ telegramId: bounty.claimerTelegramId });
  if (!creator || !claimer)
    return { success: false, error: "Could not find the involved users." };

  const decimals = await getTokenDecimals();
  const amount = parseUnits(bounty.amount, decimals);

  const balance = await getTokenBalance(creator.smartAccountAddress as Hex);
  if (balance < amount) {
    const formatted = await formatBalance(creator.smartAccountAddress as Hex);
    return {
      success: false,
      error: `Insufficient balance. You have ${formatted}.`,
    };
  }

  const txHash = await sendTokens(
    creator.privateKey as Hex,
    claimer.smartAccountAddress as Hex,
    amount,
  );

  await User.updateOne(
    { telegramId: creator.telegramId },
    { isDeployed: true },
  );
  await Bounty.updateOne(
    { shortId },
    { status: "completed", completedAt: new Date() },
  );

  const symbol = await getTokenSymbol();
  return { success: true, txHash, symbol };
}

export async function denyBounty(shortId: string) {
  await Bounty.updateOne(
    { shortId },
    { status: "open", $unset: { claimerTelegramId: 1 } },
  );
}

export async function cancelBounty(
  shortId: string,
  telegramId: string,
): Promise<{ success: boolean; error?: string }> {
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) return { success: false, error: "Bounty not found." };
  if (bounty.creatorTelegramId !== telegramId)
    return { success: false, error: "Only the bounty creator can cancel it." };
  if (bounty.status === "completed")
    return { success: false, error: "This bounty is already completed." };

  await Bounty.updateOne({ shortId }, { status: "cancelled" });
  return { success: true };
}
