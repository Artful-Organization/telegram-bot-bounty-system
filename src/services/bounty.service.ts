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
  console.log(`[bounty] creating bounty: creator=${creatorTelegramId} amount=${amount} desc="${description}"`);
  let shortId = generateShortId();
  while (await Bounty.exists({ shortId })) {
    shortId = generateShortId();
  }

  const bounty = await Bounty.create({
    shortId,
    creatorTelegramId,
    description,
    amount,
  });
  console.log(`[bounty] created #${shortId}`);
  return bounty;
}

export async function listOpenBounties(search?: string) {
  console.log(`[bounty] listing open bounties${search ? ` search="${search}"` : ""}`);
  const filter: Record<string, unknown> = { status: "open" };

  if (search) {
    const regex = new RegExp(search, "i");
    const matchingUsers = await User.find({
      $or: [{ telegramId: search }, { username: regex }, { displayName: regex }],
    }).select("telegramId").lean();
    const telegramIds = matchingUsers.map((u) => u.telegramId);

    filter.$or = [
      { description: regex },
      { creatorTelegramId: search },
      { creatorTelegramId: { $in: telegramIds } },
    ];
  }

  const bounties = await Bounty.find(filter).sort({ createdAt: -1 }).lean();
  console.log(`[bounty] found ${bounties.length} open bounties`);

  const creatorIds = [...new Set(bounties.map((b) => b.creatorTelegramId))];
  const creators = await User.find({ telegramId: { $in: creatorIds } })
    .select("telegramId username displayName")
    .lean();
  const creatorMap = new Map(creators.map((u) => [u.telegramId, u]));

  return bounties.map((b) => {
    const creator = creatorMap.get(b.creatorTelegramId);
    return {
      ...b,
      creatorUsername: creator?.username ?? null,
      creatorDisplayName: creator?.displayName ?? null,
    };
  });
}

export type ClaimResult =
  | { success: true }
  | { success: false; error: string };

export async function claimBounty(
  shortId: string,
  claimerTelegramId: string,
): Promise<ClaimResult> {
  console.log(`[bounty] claimBounty: #${shortId} by ${claimerTelegramId}`);
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) {
    console.log(`[bounty] claim rejected: bounty #${shortId} not found`);
    return { success: false, error: "Bounty not found." };
  }
  if (bounty.status !== "open") {
    console.log(`[bounty] claim rejected: #${shortId} status=${bounty.status}`);
    return { success: false, error: "This bounty is not open for claims." };
  }
  if (bounty.creatorTelegramId === claimerTelegramId) {
    console.log(`[bounty] claim rejected: #${shortId} self-claim`);
    return { success: false, error: "You can't claim your own bounty." };
  }

  const claimer = await User.findOne({ telegramId: claimerTelegramId });
  if (!claimer) {
    console.log(`[bounty] claim rejected: claimer ${claimerTelegramId} has no wallet`);
    return { success: false, error: "You don't have a wallet yet. Use /start first." };
  }

  await Bounty.updateOne(
    { shortId },
    { status: "claimed", claimerTelegramId },
  );
  console.log(`[bounty] #${shortId} claimed by ${claimerTelegramId}`);
  return { success: true };
}

export type ConfirmResult =
  | { success: true; txHash: Hex; symbol: string }
  | { success: false; error: string };

export async function confirmBounty(shortId: string): Promise<ConfirmResult> {
  console.log(`[bounty] confirmBounty: #${shortId}`);
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) {
    console.log(`[bounty] confirm rejected: bounty #${shortId} not found`);
    return { success: false, error: "Bounty not found." };
  }
  if (bounty.status !== "claimed") {
    console.log(`[bounty] confirm rejected: #${shortId} status=${bounty.status}`);
    return { success: false, error: "This bounty has no pending claim." };
  }

  const creator = await User.findOne({ telegramId: bounty.creatorTelegramId });
  const claimer = await User.findOne({ telegramId: bounty.claimerTelegramId });
  if (!creator || !claimer) {
    console.log(`[bounty] confirm rejected: missing users creator=${bounty.creatorTelegramId} claimer=${bounty.claimerTelegramId}`);
    return { success: false, error: "Could not find the involved users." };
  }

  const decimals = await getTokenDecimals();
  const amount = parseUnits(bounty.amount, decimals);

  const balance = await getTokenBalance(creator.smartAccountAddress as Hex);
  console.log(`[bounty] #${shortId} creator balance check: has=${balance} need=${amount}`);
  if (balance < amount) {
    const formatted = await formatBalance(creator.smartAccountAddress as Hex);
    console.log(`[bounty] confirm rejected: insufficient balance ${formatted}`);
    return {
      success: false,
      error: `Insufficient balance. You have ${formatted}.`,
    };
  }

  console.log(`[bounty] #${shortId} transferring ${bounty.amount} from ${creator.smartAccountAddress} to ${claimer.smartAccountAddress}...`);
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
  console.log(`[bounty] #${shortId} COMPLETED: ${bounty.amount} $${symbol} tx=${txHash}`);
  return { success: true, txHash, symbol };
}

export async function denyBounty(shortId: string) {
  console.log(`[bounty] denying claim on #${shortId}`);
  await Bounty.updateOne(
    { shortId },
    { status: "open", $unset: { claimerTelegramId: 1 } },
  );
  console.log(`[bounty] #${shortId} claim denied, reopened`);
}

export async function cancelBounty(
  shortId: string,
  telegramId: string,
): Promise<{ success: boolean; error?: string }> {
  console.log(`[bounty] cancelBounty: #${shortId} by ${telegramId}`);
  const bounty = await Bounty.findOne({ shortId });
  if (!bounty) {
    console.log(`[bounty] cancel rejected: bounty #${shortId} not found`);
    return { success: false, error: "Bounty not found." };
  }
  if (bounty.creatorTelegramId !== telegramId) {
    console.log(`[bounty] cancel rejected: #${shortId} not creator (${telegramId} != ${bounty.creatorTelegramId})`);
    return { success: false, error: "Only the bounty creator can cancel it." };
  }
  if (bounty.status === "completed") {
    console.log(`[bounty] cancel rejected: #${shortId} already completed`);
    return { success: false, error: "This bounty is already completed." };
  }

  await Bounty.updateOne({ shortId }, { status: "cancelled" });
  console.log(`[bounty] #${shortId} cancelled`);
  return { success: true };
}
