import crypto from "node:crypto";
import mongoose from "mongoose";
import { Bot, InlineKeyboard } from "grammy";
import { parseUnits, type Hex } from "viem";
import { BOT_TOKEN, chain, OWNER_PRIVATE_KEY, OWNER_SAFE_ADDRESS, ADMIN_TELEGRAM_ID, BOUNTY_CHAT_ID, TOKEN_CONTRACT_ADDRESS } from "./config.js";
import { connectDB } from "./db/connection.js";
import { User } from "./db/models/user.model.js";
import { createWallet } from "./services/wallet.service.js";
import {
  sendTokens,
  formatBalance,
  getTokenBalance,
  getTokenDecimals,
  getTokenSymbol,
  performTransfer,
} from "./services/transfer.service.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
import {
  createBounty,
  listOpenBounties,
  claimBounty,
  confirmBounty,
  denyBounty,
  cancelBounty,
} from "./services/bounty.service.js";
import { Bounty } from "./db/models/bounty.model.js";
import { ChatMessage } from "./db/models/chat-message.model.js";
import { invokeAgent } from "./agent/index.js";
import { transcribeAudio } from "./services/transcription.service.js";

const bot = new Bot(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.message?.text && ctx.chat && ctx.from) {
    await ChatMessage.create({
      chatId: ctx.chat.id.toString(),
      messageId: ctx.message.message_id,
      senderTelegramId: ctx.from.id.toString(),
      senderUsername: ctx.from.username ?? undefined,
      senderDisplayName: ctx.from.last_name
        ? `${ctx.from.first_name} ${ctx.from.last_name}`
        : ctx.from.first_name,
      isBot: ctx.from.is_bot,
      text: ctx.message.text,
    }).catch(() => {});

    ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
  }
  await next();
});

bot.api.config.use(async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);
  if (result.ok) {
    const msg = result.result as unknown as Record<string, unknown>;
    const chat = msg?.chat as Record<string, unknown> | undefined;
    if (chat?.id && msg?.message_id && typeof msg?.text === "string") {
      ChatMessage.updateOne(
        { chatId: String(chat.id), messageId: msg.message_id },
        {
          chatId: String(chat.id),
          messageId: msg.message_id,
          senderTelegramId: String(bot.botInfo?.id ?? "bot"),
          senderUsername: bot.botInfo?.username ?? undefined,
          senderDisplayName: bot.botInfo?.first_name ?? "Bot",
          isBot: true,
          text: msg.text,
        },
        { upsert: true },
      ).catch(() => {});
    }
  }
  return result;
});

const explorerBaseUrl = "https://basescan.org";

function log(command: string, userId: string, username: string | null, details: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] /${command} | user=${userId} (@${username ?? "none"}) | ${details}`);
}

function buildDisplayName(from: { first_name: string; last_name?: string }): string {
  return from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name;
}

function syncProfile(from: { id: number; username?: string; first_name: string; last_name?: string }) {
  const telegramId = from.id.toString();
  User.updateOne(
    { telegramId },
    { username: from.username ?? null, displayName: buildDisplayName(from) },
  ).catch(() => {});
}

function startTyping(ctx: { chat: { id: number } }) {
  const chatId = ctx.chat.id;
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  const timeout = setTimeout(() => clearInterval(interval), 60_000);
  return { stop: () => { clearInterval(interval); clearTimeout(timeout); } };
}

async function notifyRecipient(recipientTelegramId: string, senderUsername: string | null, amountStr: string, txHash: string) {
  const senderTag = senderUsername ? `@${senderUsername}` : "Someone";
  const symbol = await getTokenSymbol();
  console.log(`[notify] notifying recipient ${recipientTelegramId}: received ${amountStr} $${symbol} from ${senderTag}`);
  try {
    await bot.api.sendMessage(
      recipientTelegramId,
      `You received ${amountStr} $${symbol} from ${senderTag}!\n\n<a href="${explorerBaseUrl}/tx/${txHash}">View Transaction</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    console.log(`[notify] recipient ${recipientTelegramId} notified`);
  } catch (err) {
    console.error(`[notify] FAILED to notify recipient ${recipientTelegramId}:`, err);
  }
}

async function notifySender(senderTelegramId: string, recipientUsername: string | null, amountStr: string, txHash: string) {
  const recipientTag = recipientUsername ? `@${recipientUsername}` : "someone";
  const symbol = await getTokenSymbol();
  console.log(`[notify] notifying sender ${senderTelegramId}: sent ${amountStr} $${symbol} to ${recipientTag}`);
  try {
    await bot.api.sendMessage(
      senderTelegramId,
      `You sent ${amountStr} $${symbol} to ${recipientTag}.\n\n<a href="${explorerBaseUrl}/tx/${txHash}">View Transaction</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    console.log(`[notify] sender ${senderTelegramId} notified`);
  } catch (err) {
    console.error(`[notify] FAILED to notify sender ${senderTelegramId}:`, err);
  }
}

interface PendingTransfer {
  senderTelegramId: string;
  senderUsername: string | null;
  recipientUsername: string;
  amount: string;
  symbol: string;
  chatId: string;
  createdAt: number;
}

const pendingTransfers = new Map<string, PendingTransfer>();
const PENDING_TRANSFER_TTL = 5 * 60 * 1000;

bot.command("start", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  const username = ctx.from?.username ?? null;

  log("start", telegramId, username, "wallet creation requested");

  const existing = await User.findOne({ telegramId });
  if (existing) {
    syncProfile(ctx.from!);
    log("start", telegramId, username, `already has wallet ${existing.smartAccountAddress}`);
    return ctx.reply(
      `You already have a wallet:\n<code>${existing.smartAccountAddress}</code>`,
      { parse_mode: "HTML" },
    );
  }

  const statusMsg = await ctx.reply("Creating your wallet...");

  try {
    const { address, privateKey } = await createWallet();

    await User.create({
      telegramId,
      username,
      displayName: buildDisplayName(ctx.from!),
      smartAccountAddress: address,
      privateKey,
    });

    log("start", telegramId, username, `wallet created: ${address}`);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Wallet created!\n\n<code>${address}</code>\n\n<a href="${explorerBaseUrl}/address/${address}">View on Explorer</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    log("start", telegramId, username, `FAILED: ${err}`);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "Failed to create wallet. Please try again later.",
    );
  }
});

bot.command("send", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const senderUsername = ctx.from?.username ?? null;

  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply("Usage: /send @username amount\nExample: /send @dan 10");
  }

  const recipientUsername = parts[1].replace("@", "");
  const amountStr = parts[2];
  const amountNum = Number(amountStr);

  if (isNaN(amountNum) || amountNum <= 0) {
    return ctx.reply("Invalid amount. Must be a positive number.");
  }

  log("send", telegramId, senderUsername, `sending ${amountStr} to @${recipientUsername}`);

  const statusMsg = await ctx.reply("Processing transfer...");

  try {
    const result = await performTransfer(telegramId, recipientUsername, amountStr);

    if (!result.success) {
      log("send", telegramId, senderUsername, `rejected: ${result.error}`);
      return ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        result.error,
      );
    }

    log("send", telegramId, senderUsername, `SUCCESS tx=${result.txHash}`);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Sent ${amountStr} tokens to @${recipientUsername}!\n\n<a href="${explorerBaseUrl}/tx/${result.txHash}">View Transaction</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );

    await notifyRecipient(result.recipientTelegramId, senderUsername, amountStr, result.txHash);
    await notifySender(telegramId, result.recipientUsername, amountStr, result.txHash);
  } catch (err) {
    log("send", telegramId, senderUsername, `FAILED: ${err}`);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "Transfer failed. Please try again later.",
    );
  }
});

bot.command("fund", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  if (ADMIN_TELEGRAM_ID && telegramId !== ADMIN_TELEGRAM_ID) {
    log("fund", telegramId, username, "DENIED: not admin");
    return ctx.reply("Only the admin can use /fund.");
  }

  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply("Usage: /fund @username amount\nExample: /fund @dan 100");
  }

  const recipientUsername = parts[1].replace("@", "");
  const amountStr = parts[2];
  const amountNum = Number(amountStr);

  if (isNaN(amountNum) || amountNum <= 0) {
    return ctx.reply("Invalid amount. Must be a positive number.");
  }

  log("fund", telegramId, username, `funding @${recipientUsername} with ${amountStr}`);

  const recipient = await User.findOne({
    username: { $regex: new RegExp(`^${escapeRegex(recipientUsername)}$`, "i") },
  });
  if (!recipient) {
    log("fund", telegramId, username, `recipient @${recipientUsername} not found`);
    return ctx.reply(
      `@${recipientUsername} doesn't have a wallet. Tell them to /start first.`,
    );
  }

  const statusMsg = await ctx.reply("Funding...");

  try {
    const decimals = await getTokenDecimals();
    const amount = parseUnits(amountStr, decimals);

    const balance = await getTokenBalance(OWNER_SAFE_ADDRESS);
    if (balance < amount) {
      const formatted = await formatBalance(OWNER_SAFE_ADDRESS);
      log("fund", telegramId, username, `insufficient treasury: ${formatted}`);
      return ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `Insufficient treasury balance. Treasury has ${formatted}.`,
      );
    }

    log("fund", telegramId, username, `submitting UserOp: ${amountStr} -> @${recipientUsername} (${recipient.smartAccountAddress})`);

    const txHash = await sendTokens(
      OWNER_PRIVATE_KEY,
      recipient.smartAccountAddress as Hex,
      amount,
    );

    log("fund", telegramId, username, `SUCCESS tx=${txHash}`);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Funded @${recipientUsername} with ${amountStr} tokens!\n\n<a href="${explorerBaseUrl}/tx/${txHash}">View Transaction</a>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );

    await notifyRecipient(recipient.telegramId, "Treasury", amountStr, txHash);
  } catch (err) {
    log("fund", telegramId, username, `FAILED: ${err}`);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "Fund failed. Please try again later.",
    );
  }
});

bot.command("balance", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const user = await User.findOne({ telegramId });
  if (!user) return ctx.reply("You don't have a wallet yet. Use /start first.");

  log("balance", telegramId, username, `checking balance for ${user.smartAccountAddress}`);

  try {
    const formatted = await formatBalance(user.smartAccountAddress as Hex);
    log("balance", telegramId, username, `balance: ${formatted}`);
    await ctx.reply(`Your balance: ${formatted}`);
  } catch (err) {
    log("balance", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to fetch balance. Please try again later.");
  }
});

bot.command("wallet", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const user = await User.findOne({ telegramId });
  if (!user) return ctx.reply("You don't have a wallet yet. Use /start first.");

  const status = user.isDeployed ? "Deployed" : "Not yet deployed (deploys on first send)";

  log("wallet", telegramId, username, `viewed wallet ${user.smartAccountAddress}`);

  await ctx.reply(
    `Your wallet:\n\n<code>${user.smartAccountAddress}</code>\n\nStatus: ${status}\n<a href="${explorerBaseUrl}/address/${user.smartAccountAddress}">View on Explorer</a>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
});

bot.command("bounty", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/bounty\s+(\S+)\s+(.+)$/);
  if (!match) {
    return ctx.reply("Usage: /bounty <amount> <description>\nExample: /bounty 50 Fix the homepage layout");
  }

  const amountStr = match[1];
  const description = match[2];
  const amountNum = Number(amountStr);

  if (isNaN(amountNum) || amountNum <= 0) {
    return ctx.reply("Invalid amount. Must be a positive number.");
  }

  log("bounty", telegramId, username, `creating bounty: "${description}" for ${amountStr}`);

  try {
    const result = await createBounty(telegramId, description, amountStr);
    if (!result.success) {
      log("bounty", telegramId, username, `rejected: ${result.error}`);
      return ctx.reply(result.error);
    }

    const { bounty } = result;
    const symbol = await getTokenSymbol();
    const poster = username ? `@${username}` : buildDisplayName(ctx.from!);

    log("bounty", telegramId, username, `created bounty #${bounty.shortId}`);

    const bountyMsg =
      `<b>Bounty #${bounty.shortId}</b>\n\n` +
      `${description}\n\n` +
      `Reward: <b>${amountStr} $${symbol}</b>\n` +
      `Posted by: ${poster}\n\n` +
      `To claim: <code>/claim ${bounty.shortId}</code>`;

    await ctx.reply(bountyMsg, { parse_mode: "HTML" });

    if (BOUNTY_CHAT_ID && BOUNTY_CHAT_ID !== ctx.chat.id.toString()) {
      try {
        await bot.api.sendMessage(BOUNTY_CHAT_ID, bountyMsg, { parse_mode: "HTML" });
      } catch (err) {
        log("bounty", telegramId, username, `failed to post to bounty chat: ${err}`);
      }
    }
  } catch (err) {
    log("bounty", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to create bounty. Please try again later.");
  }
});

bot.command("bounties", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const text = ctx.message?.text ?? "";
  const search = text.replace(/^\/bounties\s*/, "").trim() || undefined;

  log("bounties", telegramId, username, `listing bounties${search ? ` search="${search}"` : ""}`);

  try {
    const bounties = await listOpenBounties(search);
    log("bounties", telegramId, username, `found ${bounties.length} bounties`);
    if (bounties.length === 0) {
      return ctx.reply(search ? `No open bounties matching "${search}".` : "No open bounties right now.");
    }

    const symbol = await getTokenSymbol();
    const lines = bounties.map((b) => {
      const poster = b.creatorUsername ? `@${b.creatorUsername}` : (b.creatorDisplayName ?? "Unknown");
      return `<b>#${b.shortId}</b> — ${b.amount} $${symbol}\n${b.description}\nby ${poster}`;
    });

    const header = search ? `<b>Bounties matching "${search}"</b>` : "<b>Open Bounties</b>";
    await ctx.reply(
      `${header}\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    log("bounties", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to list bounties. Please try again later.");
  }
});

bot.command("claim", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply("Usage: /claim <bountyId>\nExample: /claim a3f9x2");
  }

  const shortId = parts[1];

  log("claim", telegramId, username, `claiming bounty #${shortId}`);

  try {
    const result = await claimBounty(shortId, telegramId);
    if (!result.success) {
      log("claim", telegramId, username, `rejected: ${result.error}`);
      return ctx.reply(result.error);
    }

    const bounty = await Bounty.findOne({ shortId });
    if (!bounty) return ctx.reply("Bounty not found.");

    const creator = await User.findOne({ telegramId: bounty.creatorTelegramId });
    const symbol = await getTokenSymbol();

    await notifyBountyCreator(
      bounty.creatorTelegramId,
      username,
      shortId,
      bounty.description,
      bounty.amount,
      symbol,
    );

    log("claim", telegramId, username, `claimed bounty #${shortId}`);

    const creatorTag = creator?.username ? `@${creator.username}` : "the bounty creator";
    await ctx.reply(`Claim submitted! Waiting for ${creatorTag} to review.`);
  } catch (err) {
    log("claim", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to submit claim. Please try again later.");
  }
});

bot.command("cancel_bounty", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply("Usage: /cancel_bounty <bountyId>\nExample: /cancel_bounty a3f9x2");
  }

  const shortId = parts[1];

  log("cancel_bounty", telegramId, username, `cancelling bounty #${shortId}`);

  try {
    const result = await cancelBounty(shortId, telegramId);
    if (!result.success) {
      log("cancel_bounty", telegramId, username, `rejected: ${result.error}`);
      return ctx.reply(result.error!);
    }

    log("cancel_bounty", telegramId, username, `cancelled bounty #${shortId}`);
    await ctx.reply(`Bounty #${shortId} has been cancelled.`);
  } catch (err) {
    log("cancel_bounty", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to cancel bounty. Please try again later.");
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCallbackQuery({ text: "Could not identify you." });
  const username = ctx.from?.username ?? null;

  log("callback", telegramId, username, `callback_query: ${data}`);

  const transferConfirmMatch = data.match(/^transfer_confirm_(.+)$/);
  const transferCancelMatch = data.match(/^transfer_cancel_(.+)$/);

  if (transferConfirmMatch || transferCancelMatch) {
    const transferId = (transferConfirmMatch ?? transferCancelMatch)![1];
    const pending = pendingTransfers.get(transferId);

    if (!pending) {
      return ctx.answerCallbackQuery({ text: "This transfer is no longer available." });
    }
    if (Date.now() - pending.createdAt > PENDING_TRANSFER_TTL) {
      pendingTransfers.delete(transferId);
      await ctx.editMessageText("This transfer has expired.", { parse_mode: "HTML" });
      return ctx.answerCallbackQuery({ text: "Transfer expired." });
    }
    if (pending.senderTelegramId !== telegramId) {
      return ctx.answerCallbackQuery({ text: "Only the sender can confirm this transfer." });
    }

    if (transferCancelMatch) {
      pendingTransfers.delete(transferId);
      log("transfer_cancel", telegramId, username, `cancelled transfer of ${pending.amount} to @${pending.recipientUsername}`);
      await ctx.editMessageText(
        `<b>Transfer Cancelled</b>\n\n${pending.amount} $${pending.symbol} to @${pending.recipientUsername} was cancelled.`,
        { parse_mode: "HTML" },
      );
      return ctx.answerCallbackQuery({ text: "Transfer cancelled." });
    }

    pendingTransfers.delete(transferId);
    log("transfer_confirm", telegramId, username, `confirming transfer of ${pending.amount} to @${pending.recipientUsername}`);
    await ctx.answerCallbackQuery({ text: "Processing transfer..." });

    try {
      const result = await performTransfer(pending.senderTelegramId, pending.recipientUsername, pending.amount);

      if (!result.success) {
        log("transfer_confirm", telegramId, username, `rejected: ${result.error}`);
        await ctx.editMessageText(
          `<b>Transfer Failed</b>\n\n${result.error}`,
          { parse_mode: "HTML" },
        );
        return;
      }

      log("transfer_confirm", telegramId, username, `SUCCESS tx=${result.txHash}`);

      await ctx.editMessageText(
        `<b>Transfer Complete</b>\n\n` +
        `Sent ${pending.amount} $${pending.symbol} to @${pending.recipientUsername}!\n\n` +
        `<a href="${explorerBaseUrl}/tx/${result.txHash}">View Transaction</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );

      await notifyRecipient(result.recipientTelegramId, pending.senderUsername, pending.amount, result.txHash);
      await notifySender(pending.senderTelegramId, result.recipientUsername, pending.amount, result.txHash);
    } catch (err) {
      log("transfer_confirm", telegramId, username, `FAILED: ${err}`);
      await ctx.editMessageText(
        `<b>Transfer Failed</b>\n\nSomething went wrong. Please try again.`,
        { parse_mode: "HTML" },
      );
    }
    return;
  }

  const confirmMatch = data.match(/^bounty_confirm_(.+)$/);
  const denyMatch = data.match(/^bounty_deny_(.+)$/);

  if (!confirmMatch && !denyMatch) return;

  const shortId = (confirmMatch ?? denyMatch)![1];
  const bounty = await Bounty.findOne({ shortId });

  if (!bounty) {
    return ctx.answerCallbackQuery({ text: "Bounty not found." });
  }
  if (bounty.creatorTelegramId !== telegramId) {
    return ctx.answerCallbackQuery({ text: "Only the bounty creator can do this." });
  }
  if (bounty.status !== "claimed") {
    return ctx.answerCallbackQuery({ text: "This bounty has no pending claim." });
  }

  const claimer = await User.findOne({ telegramId: bounty.claimerTelegramId });
  const claimerTag = claimer?.username ? `@${claimer.username}` : "the claimer";
  const symbol = await getTokenSymbol();

  if (confirmMatch) {
    log("bounty_confirm", telegramId, username, `confirming bounty #${shortId}`);

    await ctx.answerCallbackQuery({ text: "Processing transfer..." });

    try {
      const result = await confirmBounty(shortId);
      if (!result.success) {
        log("bounty_confirm", telegramId, username, `rejected: ${result.error}`);
        await ctx.editMessageText(
          `<b>Bounty #${shortId}</b> — Confirmation failed\n\n${result.error}`,
          { parse_mode: "HTML" },
        );
        return;
      }

      log("bounty_confirm", telegramId, username, `SUCCESS tx=${result.txHash}`);

      await ctx.editMessageText(
        `<b>Bounty #${shortId} — Completed</b>\n\n` +
        `${bounty.amount} $${symbol} sent to ${claimerTag}!\n\n` +
        `<a href="${explorerBaseUrl}/tx/${result.txHash}">View Transaction</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );

      await notifySender(bounty.creatorTelegramId, claimer?.username ?? null, bounty.amount, result.txHash);

      if (bounty.claimerTelegramId) {
        try {
          await bot.api.sendMessage(
            bounty.claimerTelegramId,
            `Your claim on bounty <b>#${shortId}</b> was confirmed! You received <b>${bounty.amount} $${symbol}</b>.\n\n` +
            `<a href="${explorerBaseUrl}/tx/${result.txHash}">View Transaction</a>`,
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          );
        } catch {
          log("bounty_confirm", telegramId, username, `failed to notify claimer ${bounty.claimerTelegramId}`);
        }
      }
    } catch (err) {
      log("bounty_confirm", telegramId, username, `FAILED: ${err}`);
      await ctx.editMessageText(
        `<b>Bounty #${shortId}</b> — Transfer failed. Please try again.`,
        { parse_mode: "HTML" },
      );
    }
  } else {
    log("bounty_deny", telegramId, username, `denying claim on bounty #${shortId}`);

    await denyBounty(shortId);

    await ctx.answerCallbackQuery({ text: "Claim denied." });

    await ctx.editMessageText(
      `<b>Bounty #${shortId}</b> — Claim denied\n\nThe bounty is open again.`,
      { parse_mode: "HTML" },
    );

    if (bounty.claimerTelegramId) {
      try {
        await bot.api.sendMessage(
          bounty.claimerTelegramId,
          `Your claim on bounty <b>#${shortId}</b> (${bounty.description}) was denied. The bounty is open again.`,
          { parse_mode: "HTML" },
        );
      } catch {
        log("bounty_deny", telegramId, username, `failed to notify claimer ${bounty.claimerTelegramId}`);
      }
    }

    log("bounty_deny", telegramId, username, `denied claim on bounty #${shortId}`);
  }
});

async function notifyBountyCreator(
  creatorTelegramId: string,
  claimerUsername: string | null,
  bountyShortId: string,
  bountyDescription: string,
  bountyAmount: string,
  symbol: string,
) {
  const claimerTag = claimerUsername ? `@${claimerUsername}` : "Someone";
  console.log(`[notify] notifying bounty creator ${creatorTelegramId}: claim on #${bountyShortId} by ${claimerTag}`);
  const keyboard = new InlineKeyboard()
    .text("Confirm", `bounty_confirm_${bountyShortId}`)
    .text("Deny", `bounty_deny_${bountyShortId}`);

  try {
    await bot.api.sendMessage(
      creatorTelegramId,
      `<b>Bounty Claim</b>\n\n` +
      `${claimerTag} claims to have completed your bounty:\n\n` +
      `<b>#${bountyShortId}</b> — ${bountyDescription}\n` +
      `Reward: <b>${bountyAmount} $${symbol}</b>`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
    console.log(`[notify] bounty creator ${creatorTelegramId} notified with confirm/deny buttons`);
  } catch (err) {
    console.error(`[notify] FAILED to notify bounty creator ${creatorTelegramId}:`, err);
  }
}

bot.on("message:voice", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;
  log("voice", telegramId, username, `voice message received (${ctx.message.voice.duration}s)`);

  const typing = startTyping(ctx);

  try {
    const file = await ctx.getFile();
    log("voice", telegramId, username, `downloading file: ${file.file_path} (${file.file_size ?? "?"} bytes)`);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download voice file: ${res.status}`);
    const audioBuffer = await res.arrayBuffer();
    log("voice", telegramId, username, `downloaded ${audioBuffer.byteLength} bytes, transcribing...`);

    const text = await transcribeAudio(audioBuffer, ctx.message.voice.mime_type ?? "audio/ogg");
    if (!text) {
      typing.stop();
      await ctx.reply("Couldn't transcribe the voice message.");
      return;
    }

    log("voice", telegramId, username, `transcribed: ${text.slice(0, 120)}`);

    await ChatMessage.create({
      chatId: ctx.chat.id.toString(),
      messageId: ctx.message.message_id,
      senderTelegramId: telegramId,
      senderUsername: username ?? undefined,
      senderDisplayName: buildDisplayName(ctx.from!),
      isBot: false,
      text,
    }).catch((err) => console.error("[voice] failed to save transcribed message:", err));

    await ctx.reply(`🗣 ${text}`, { reply_parameters: { message_id: ctx.message.message_id } });

    const replyToText = ctx.message.reply_to_message?.text ?? undefined;
    const chatId = ctx.chat.id.toString();
    const response = await invokeAgent(chatId, {
      senderTelegramId: telegramId,
      senderUsername: username,
      senderDisplayName: buildDisplayName(ctx.from!),
      notifyRecipient,
      notifySender,
      notifyBountyCreator,
      postBounty: async (msg) => {
        if (BOUNTY_CHAT_ID) {
          try {
            await bot.api.sendMessage(BOUNTY_CHAT_ID, msg, { parse_mode: "HTML" });
          } catch (err) {
            console.error("Failed to post bounty to group:", err);
          }
        }
      },
      requestTransferConfirm: async (recipientUsername, amount, symbol) => {
        const id = crypto.randomBytes(8).toString("hex");
        pendingTransfers.set(id, {
          senderTelegramId: telegramId,
          senderUsername: username,
          recipientUsername,
          amount,
          symbol,
          chatId,
          createdAt: Date.now(),
        });
        const keyboard = new InlineKeyboard()
          .text("Confirm", `transfer_confirm_${id}`)
          .text("Cancel", `transfer_cancel_${id}`);
        await bot.api.sendMessage(
          ctx.chat.id,
          `<b>Confirm Transfer</b>\n\nSend <b>${amount} $${symbol}</b> to @${recipientUsername}?`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      },
    }, replyToText);
    typing.stop();
    log("voice", telegramId, username, `agent response: ${response.slice(0, 120)}`);
    await ctx.reply(response, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    typing.stop();
    log("voice", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to process voice message. Please try again later.");
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;
  const replyToText = ctx.message.reply_to_message?.text ?? undefined;
  log("agent", telegramId, username, `message: ${text}${replyToText ? ` (reply to: "${replyToText.slice(0, 80)}")` : ""}`);

  const typing = startTyping(ctx);
  const chatId = ctx.chat.id.toString();

  try {
    const response = await invokeAgent(chatId, {
      senderTelegramId: telegramId,
      senderUsername: username,
      senderDisplayName: buildDisplayName(ctx.from!),
      notifyRecipient,
      notifySender,
      notifyBountyCreator,
      postBounty: async (msg) => {
        if (BOUNTY_CHAT_ID) {
          try {
            await bot.api.sendMessage(BOUNTY_CHAT_ID, msg, { parse_mode: "HTML" });
          } catch (err) {
            console.error("Failed to post bounty to group:", err);
          }
        }
      },
      requestTransferConfirm: async (recipientUsername, amount, symbol) => {
        const id = crypto.randomBytes(8).toString("hex");
        pendingTransfers.set(id, {
          senderTelegramId: telegramId,
          senderUsername: username,
          recipientUsername,
          amount,
          symbol,
          chatId,
          createdAt: Date.now(),
        });
        const keyboard = new InlineKeyboard()
          .text("Confirm", `transfer_confirm_${id}`)
          .text("Cancel", `transfer_cancel_${id}`);
        await bot.api.sendMessage(
          ctx.chat.id,
          `<b>Confirm Transfer</b>\n\nSend <b>${amount} $${symbol}</b> to @${recipientUsername}?`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      },
    }, replyToText);
    typing.stop();
    log("agent", telegramId, username, `response: ${response.slice(0, 120)}`);
    await ctx.reply(response, { link_preview_options: { is_disabled: true } });
  } catch (err) {
    typing.stop();
    log("agent", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Something went wrong. Please try again later.");
  }
});

async function main() {
  await connectDB();

  await bot.api.setMyCommands([
    { command: "start", description: "Create your wallet" },
    { command: "send", description: "Send tokens — /send @username amount" },
    { command: "balance", description: "Check your token balance" },
    { command: "wallet", description: "View your wallet address" },
    { command: "bounty", description: "Post a bounty — /bounty <amount> <description>" },
    { command: "bounties", description: "List/search bounties — /bounties [search]" },
    { command: "claim", description: "Claim a bounty — /claim <bountyId>" },
    { command: "cancel_bounty", description: "Cancel your bounty — /cancel_bounty <bountyId>" },
    { command: "fund", description: "Admin: fund a user — /fund @username amount" },
  ]);

  console.log("[bot] commands registered");
  console.log(`[bot] chain: ${chain.name} (${chain.id})`);
  console.log(`[bot] token contract: ${TOKEN_CONTRACT_ADDRESS}`);
  console.log(`[bot] admin: ${ADMIN_TELEGRAM_ID || "none"}`);
  console.log(`[bot] bounty chat: ${BOUNTY_CHAT_ID || "none"}`);
  console.log("[bot] starting...");

  const shutdown = async (signal: string) => {
    console.log(`[bot] received ${signal}, shutting down gracefully...`);
    bot.stop();
    await mongoose.disconnect();
    console.log("[bot] shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  bot.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
