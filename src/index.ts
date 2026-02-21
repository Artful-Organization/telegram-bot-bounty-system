import crypto from "node:crypto";
import mongoose from "mongoose";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { parseUnits, type Hex } from "viem";
import QRCode from "qrcode";
import { BOT_TOKEN, chain, OWNER_PRIVATE_KEY, OWNER_SAFE_ADDRESS, ADMIN_TELEGRAM_ID, BOUNTY_CHAT_ID, GAMES_CHAT_ID, TOKEN_CONTRACT_ADDRESS } from "./config.js";
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
  waitForBlock,
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
import { verifySelfieWithItem } from "./services/verification.service.js";
import { SelfieTask, SELFIE_TASKS } from "./db/models/selfie-task.model.js";
import { GameSession } from "./db/models/game-session.model.js";
import {
  GAME_CONFIGS,
  WAGER_OPTIONS,
  getGameConfig,
  createGameSession,
  joinGameSession,
  getSession,
  proposeWinner,
  castVote,
  payoutWinners,
  refundGame,
  cancelGame,
  adminResolveGame,
  switchTeam,
  leaveGame,
  formatPlayerLabel,
  type GameConfig,
} from "./services/game.service.js";

const bot = new Bot(BOT_TOKEN);

bot.catch((err) => {
  console.error("[bot] unhandled error:", err.message ?? err);
});

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

async function _updatePinnedBalance(telegramId: string, txHash?: Hex) {
  try {
    if (txHash) await waitForBlock(txHash);

    const user = await User.findOne({ telegramId });
    if (!user) return;

    const formatted = await formatBalance(user.smartAccountAddress as Hex);
    const text = `Balance: ${formatted}`;

    if (user.balanceMessageId) {
      try {
        await bot.api.editMessageText(telegramId, user.balanceMessageId, text);
        return;
      } catch {
        // message was deleted or inaccessible — recreate below
      }
    }

    const msg = await bot.api.sendMessage(telegramId, text, { disable_notification: true });
    await bot.api.pinChatMessage(telegramId, msg.message_id, { disable_notification: true });
    await User.updateOne({ telegramId }, { balanceMessageId: msg.message_id });
  } catch (err) {
    console.error(`[balance-pin] failed for ${telegramId}:`, err);
  }
}

function updatePinnedBalance(telegramId: string, txHash?: Hex) {
  _updatePinnedBalance(telegramId, txHash).catch(() => {});
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
  const payload = ctx.match?.toString().trim() || "";
  const joinMatch = payload.match(/^join_([a-f0-9]+)$/);

  log("start", telegramId, username, "start command" + (joinMatch ? ` (join game ${joinMatch[1]})` : ""));

  const existing = await User.findOne({ telegramId });

  if (existing) {
    syncProfile(ctx.from!);
    if (joinMatch) {
      await handleGameJoinDeepLink(ctx, joinMatch[1], telegramId, username);
      return;
    }
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

    let walletMsg = `Wallet created!\n\n<code>${address}</code>\n\n<a href="${explorerBaseUrl}/address/${address}">View on Explorer</a>`;

    if (joinMatch) {
      const session = await getSession(joinMatch[1]);
      const config = session ? getGameConfig(session.gameType) : null;
      walletMsg += `\n\nTo join ${config ? `${config.emoji} ${config.name}` : "game"} <b>#${joinMatch[1]}</b>, you need <b>${session?.wagerPerPlayer ?? "some"} tokens</b>. Get funded first, then tap Join in the group chat!`;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      walletMsg,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );

    updatePinnedBalance(telegramId);
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
    const result = await performTransfer(telegramId, recipientUsername, amountStr, updatePinnedBalance);

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
    updatePinnedBalance(recipient.telegramId, txHash);
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

// ───────────── Party Games ─────────────

bot.command("games", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);

  const symbol = await getTokenSymbol();
  const kb = new InlineKeyboard();
  for (const config of GAME_CONFIGS) {
    kb.text(`${config.emoji} ${config.name}`, `game_select_${config.id}`).row();
  }

  await ctx.reply(
    `<b>Party Games</b>\n\nPick a game to play! Wager tokens and compete.\n\nToken: $${symbol}`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

function buildLobbyCaption(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  config: GameConfig,
  symbol: string,
): string {
  const pot = parseInt(session.wagerPerPlayer) * session.totalSlots;
  const playerLabel = formatPlayerLabel(session, config);

  let playerList: string;
  if (session.teamBased) {
    const team0 = session.players.filter((p) => p.side === 0);
    const team1 = session.players.filter((p) => p.side === 1);
    const slotsPerSide = session.totalSlots / 2;
    const t0 = team0.map((p) => (p.username ? `@${p.username}` : "player")).join(", ") || "(waiting)";
    const t1 = team1.map((p) => (p.username ? `@${p.username}` : "player")).join(", ") || "(waiting)";
    playerList = `Team 1 (${team0.length}/${slotsPerSide}): ${t0}\nTeam 2 (${team1.length}/${slotsPerSide}): ${t1}`;
  } else {
    playerList = session.players.map((p) => (p.username ? `@${p.username}` : "player")).join(", ") || "(none)";
  }

  let statusLine: string;
  switch (session.status) {
    case "waiting":
      statusLine = "Scan QR or tap Join to play!";
      break;
    case "active":
      statusLine = "Game in progress!";
      break;
    case "voting": {
      const approvals = session.votes.filter((v) => v.approved).length;
      const denials = session.votes.filter((v) => !v.approved).length;
      const majority = Math.floor(session.players.length / 2) + 1;
      let winnerLabel: string;
      if (session.teamBased && session.proposedWinnerSide != null) {
        winnerLabel = `Team ${session.proposedWinnerSide + 1}`;
      } else if (session.proposedWinnerTelegramId) {
        const w = session.players.find((p) => p.telegramId === session.proposedWinnerTelegramId);
        winnerLabel = w?.username ? `@${w.username}` : "a player";
      } else {
        winnerLabel = "unknown";
      }
      statusLine = `Voting in DMs: ${winnerLabel} proposed as winner\n${approvals} yes / ${denials} no (need ${majority})`;
      break;
    }
    case "completed":
      statusLine = "Game completed! Winnings paid out.";
      break;
    case "cancelled":
      statusLine = "Game cancelled. Wagers refunded.";
      break;
    case "disputed":
      statusLine = "Disputed! Waiting for admin resolution.";
      break;
    default:
      statusLine = "";
  }

  return (
    `${config.emoji} <b>${config.name}</b> \u2014 ${playerLabel}\n` +
    `Game <b>#${session.shortId}</b>\n\n` +
    `Wager: <b>${session.wagerPerPlayer} $${symbol}</b>/player\n` +
    `Pot: <b>${pot} $${symbol}</b>\n\n` +
    `Players (${session.players.length}/${session.totalSlots}):\n${playerList}\n\n` +
    statusLine
  );
}

function buildLobbyKeyboard(session: NonNullable<Awaited<ReturnType<typeof getSession>>>): InlineKeyboard {
  const kb = new InlineKeyboard();
  const id = session.shortId;
  switch (session.status) {
    case "waiting":
      if (session.teamBased) {
        const slotsPerSide = session.totalSlots / 2;
        const t0 = session.players.filter((p) => p.side === 0).length;
        const t1 = session.players.filter((p) => p.side === 1).length;
        if (t0 < slotsPerSide) kb.text(`Join Team 1 (${t0}/${slotsPerSide})`, `game_join_${id}_0`);
        if (t1 < slotsPerSide) kb.text(`Join Team 2 (${t1}/${slotsPerSide})`, `game_join_${id}_1`);
        kb.row();
        kb.text("Switch Team", `game_switch_${id}`);
      } else {
        kb.text("Join Game", `game_join_${id}`).row();
      }
      kb.text("Leave Game", `game_leave_${id}`).row();
      kb.text("Cancel Game", `game_cancel_${id}`);
      break;
    case "active":
      kb.text("End Game", `game_end_${id}`);
      break;
    case "voting":
      break;
  }
  return kb;
}

async function sendLobbyMessage(
  chatId: number | string,
  shortId: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  config: GameConfig,
  symbol: string,
) {
  const botUsername = bot.botInfo!.username;
  const deepLink = `https://t.me/${botUsername}?start=join_${shortId}`;
  const qrBuffer = await QRCode.toBuffer(deepLink, { width: 300, margin: 2 });

  const caption = buildLobbyCaption(session, config, symbol);
  const kb = buildLobbyKeyboard(session);

  const msg = await bot.api.sendPhoto(
    chatId,
    new InputFile(qrBuffer, "game-qr.png"),
    { caption, parse_mode: "HTML", reply_markup: kb },
  );

  await GameSession.updateOne(
    { shortId },
    { lobbyMessageId: msg.message_id, lobbyChatId: chatId.toString() },
  );
}

async function refreshLobby(shortId: string) {
  const session = await getSession(shortId);
  if (!session || !session.lobbyChatId || !session.lobbyMessageId) return;
  const config = getGameConfig(session.gameType);
  if (!config) return;
  const symbol = await getTokenSymbol();
  const caption = buildLobbyCaption(session, config, symbol);
  const kb = buildLobbyKeyboard(session);
  try {
    await bot.api.editMessageCaption(session.lobbyChatId, session.lobbyMessageId, {
      caption,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch (err) {
    console.error(`[game] failed to refresh lobby #${shortId}:`, err);
  }
}

async function sendVoteDMs(
  shortId: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  config: GameConfig,
  symbol: string,
) {
  let winnerLabel: string;
  if (session.teamBased && session.proposedWinnerSide != null) {
    winnerLabel = `Team ${session.proposedWinnerSide + 1}`;
  } else if (session.proposedWinnerTelegramId) {
    const w = session.players.find((p) => p.telegramId === session.proposedWinnerTelegramId);
    winnerLabel = w?.username ? `@${w.username}` : "a player";
  } else {
    winnerLabel = "unknown";
  }

  const pot = parseInt(session.wagerPerPlayer) * session.totalSlots;
  const text =
    `${config.emoji} <b>${config.name}</b> #${shortId}\n\n` +
    `Proposed winner: <b>${winnerLabel}</b>\n` +
    `Pot: <b>${pot} $${symbol}</b>\n\n` +
    `Do you agree?`;

  const kb = new InlineKeyboard()
    .text("\u2705 Yes", `game_vote_yes_${shortId}`)
    .text("\u274C No", `game_vote_no_${shortId}`);

  for (const player of session.players) {
    try {
      await bot.api.sendMessage(player.telegramId, text, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    } catch (err) {
      console.error(`[game] failed to send vote DM to ${player.telegramId}:`, err);
    }
  }
}

async function handleGameJoinDeepLink(
  ctx: { reply: (text: string, opts?: Record<string, unknown>) => Promise<{ message_id: number }>; chat: { id: number } },
  shortId: string,
  telegramId: string,
  username: string | null,
) {
  try {
    const session = await getSession(shortId);
    if (!session) {
      await ctx.reply("Game not found.");
      return;
    }
    if (session.status !== "waiting") {
      await ctx.reply("This game is no longer accepting players.");
      return;
    }
    if (session.players.some((p) => p.telegramId === telegramId)) {
      await ctx.reply("You already joined this game.");
      return;
    }

    const config = getGameConfig(session.gameType)!;
    const symbol = await getTokenSymbol();

    if (session.teamBased) {
      const slotsPerSide = session.totalSlots / 2;
      const t0 = session.players.filter((p) => p.side === 0).length;
      const t1 = session.players.filter((p) => p.side === 1).length;
      const t0Names = session.players.filter((p) => p.side === 0).map((p) => (p.username ? `@${p.username}` : "player")).join(", ") || "(empty)";
      const t1Names = session.players.filter((p) => p.side === 1).map((p) => (p.username ? `@${p.username}` : "player")).join(", ") || "(empty)";

      const kb = new InlineKeyboard();
      if (t0 < slotsPerSide) kb.text(`Join Team 1 (${t0}/${slotsPerSide})`, `game_join_${shortId}_0`);
      if (t1 < slotsPerSide) kb.text(`Join Team 2 (${t1}/${slotsPerSide})`, `game_join_${shortId}_1`);

      await ctx.reply(
        `${config.emoji} <b>${config.name}</b> #${shortId}\n` +
        `Wager: <b>${session.wagerPerPlayer} $${symbol}</b>/player\n\n` +
        `Team 1: ${t0Names}\nTeam 2: ${t1Names}\n\n` +
        `Pick your team:`,
        { parse_mode: "HTML", reply_markup: kb } as Record<string, unknown>,
      );
      return;
    }

    const statusMsg = await ctx.reply("Collecting wager and joining game...");
    const result = await joinGameSession(shortId, telegramId, username);

    if (!result.success) {
      await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, result.error);
      return;
    }

    const updatedSession = await getSession(shortId);
    const statusText = result.isFull
      ? `Joined ${config.emoji} <b>${config.name}</b> <b>#${shortId}</b>! Game is starting!`
      : `Joined ${config.emoji} <b>${config.name}</b> <b>#${shortId}</b>! (${updatedSession?.players.length ?? "?"}/${session.totalSlots})`;

    await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, statusText, { parse_mode: "HTML" });
    await refreshLobby(shortId);
    updatePinnedBalance(telegramId, result.txHash);
  } catch (err) {
    console.error("[game] deep link join failed:", err);
    await ctx.reply("Failed to join the game. Please try again.");
  }
}

async function notifyAdminDispute(
  shortId: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  config: GameConfig,
  symbol: string,
) {
  const kb = new InlineKeyboard();
  if (session.teamBased) {
    kb.text("Team 1 wins", `game_admin_${shortId}_0`).row();
    kb.text("Team 2 wins", `game_admin_${shortId}_1`).row();
  } else {
    for (const player of session.players) {
      const label = player.username ? `@${player.username}` : player.telegramId;
      kb.text(`${label} wins`, `game_admin_${shortId}_${player.telegramId}`).row();
    }
  }
  kb.text("Refund all", `game_admin_${shortId}_refund`);

  const pot = parseInt(session.wagerPerPlayer) * session.totalSlots;
  try {
    await bot.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `<b>Game Dispute</b>\n\n` +
      `${config.emoji} <b>${config.name}</b> #${shortId}\n` +
      `Pot: <b>${pot} $${symbol}</b>\n` +
      `Players: ${session.players.map((p) => (p.username ? `@${p.username}` : p.telegramId)).join(", ")}\n\n` +
      `Participants rejected the proposed winner. Please resolve:`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch (err) {
    console.error(`[game] failed to notify admin about dispute #${shortId}:`, err);
  }
}

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
    await ctx.editMessageText(
      `Sending ${pending.amount} $${pending.symbol} to @${pending.recipientUsername}...`,
    );

    try {
      const result = await performTransfer(pending.senderTelegramId, pending.recipientUsername, pending.amount, updatePinnedBalance);

      if (!result.success) {
        log("transfer_confirm", telegramId, username, `rejected: ${result.error}`);
        await ctx.editMessageText(
          `<b>Transfer Failed</b>\n\n${result.error}`,
          { parse_mode: "HTML" },
        );
        return;
      }

      log("transfer_confirm", telegramId, username, `SUCCESS tx=${result.txHash}`);

      await ctx.deleteMessage();

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

  // ───── Game callbacks ─────
  if (data.startsWith("game_")) {
    // game_menu
    if (data === "game_menu") {
      const symbol = await getTokenSymbol();
      const kb = new InlineKeyboard();
      for (const config of GAME_CONFIGS) {
        kb.text(`${config.emoji} ${config.name}`, `game_select_${config.id}`).row();
      }
      await ctx.editMessageText(
        `<b>Party Games</b>\n\nPick a game to play! Wager tokens and compete.\n\nToken: $${symbol}`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return ctx.answerCallbackQuery();
    }

    // game_select_{type}
    const selectMatch = data.match(/^game_select_(\w+)$/);
    if (selectMatch) {
      const config = getGameConfig(selectMatch[1]);
      if (!config) return ctx.answerCallbackQuery({ text: "Unknown game." });
      const kb = new InlineKeyboard();
      for (const count of config.playerOptions) {
        const label = config.teamBased ? `${count / 2}v${count / 2}` : `${count} players`;
        kb.text(label, `game_players_${config.id}_${count}`);
      }
      kb.row().text("\u00AB Back", "game_menu");
      await ctx.editMessageText(
        `${config.emoji} <b>${config.name}</b>\n\n${config.description}\n\nHow many players?`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return ctx.answerCallbackQuery();
    }

    // game_players_{type}_{count}
    const playersMatch = data.match(/^game_players_(\w+)_(\d+)$/);
    if (playersMatch) {
      const config = getGameConfig(playersMatch[1]);
      if (!config) return ctx.answerCallbackQuery({ text: "Unknown game." });
      const count = parseInt(playersMatch[2], 10);
      const symbol = await getTokenSymbol();
      const kb = new InlineKeyboard();
      for (let i = 0; i < WAGER_OPTIONS.length; i++) {
        kb.text(`${WAGER_OPTIONS[i]} $${symbol}`, `game_wager_${config.id}_${count}_${WAGER_OPTIONS[i]}`);
        if (i % 3 === 2) kb.row();
      }
      kb.row().text("\u00AB Back", `game_select_${config.id}`);
      const label = config.teamBased ? `${count / 2}v${count / 2}` : `${count} players`;
      await ctx.editMessageText(
        `${config.emoji} <b>${config.name}</b> \u2014 ${label}\n\nWager per player?`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return ctx.answerCallbackQuery();
    }

    // game_wager_{type}_{count}_{amount} — create game
    const wagerMatch = data.match(/^game_wager_(\w+)_(\d+)_(\d+)$/);
    if (wagerMatch) {
      const config = getGameConfig(wagerMatch[1]);
      if (!config) return ctx.answerCallbackQuery({ text: "Unknown game." });
      const count = parseInt(wagerMatch[2], 10);
      const wager = wagerMatch[3];
      const isPrivate = ctx.chat?.type === "private";
      const lobbyChat = GAMES_CHAT_ID || (!isPrivate ? String(ctx.chat!.id) : "");

      if (!lobbyChat) {
        await ctx.answerCallbackQuery({ text: "No group chat configured." });
        await ctx.editMessageText(
          "Can't create a game from DMs without a group chat. Use /games in the group chat, or ask the admin to set GAMES_CHAT_ID.",
        );
        return;
      }

      await ctx.answerCallbackQuery({ text: "Creating game..." });
      await ctx.editMessageText("Creating game and collecting wager...");
      try {
        const result = await createGameSession(config.id, telegramId, username, count, wager);
        if (!result.success) {
          await ctx.editMessageText(`Failed: ${result.error}`);
          return;
        }
        const session = await getSession(result.shortId);
        if (!session) { await ctx.editMessageText("Game created but session not found."); return; }
        const symbol = await getTokenSymbol();
        const postedElsewhere = lobbyChat !== String(ctx.chat!.id);
        await ctx.editMessageText(
          `${config.emoji} <b>${config.name}</b> game <b>#${result.shortId}</b> created!\n\n` +
          (postedElsewhere ? "Lobby posted in the group chat!" : "Check the lobby below."),
          { parse_mode: "HTML" },
        );
        await sendLobbyMessage(lobbyChat, result.shortId, session, config, symbol);
        updatePinnedBalance(telegramId, result.txHash);

        const botUsername = bot.botInfo!.username;
        const deepLink = `https://t.me/${botUsername}?start=join_${result.shortId}`;
        const qrBuffer = await QRCode.toBuffer(deepLink, { width: 300, margin: 2 });
        try {
          await bot.api.sendPhoto(
            telegramId,
            new InputFile(qrBuffer, "game-qr.png"),
            {
              caption: `${config.emoji} <b>${config.name}</b> #${result.shortId}\n\nShare this QR code to invite players!\n\n${deepLink}`,
              parse_mode: "HTML",
            },
          );
        } catch (err) {
          console.error(`[game] failed to send QR DM to creator ${telegramId}:`, err);
        }
      } catch (err) {
        console.error("[game] create failed:", err);
        await ctx.editMessageText("Failed to create game. Please try again.");
      }
      return;
    }

    // game_join_{shortId} or game_join_{shortId}_{side}
    const joinMatch = data.match(/^game_join_([a-f0-9]+)(?:_(\d))?$/);
    if (joinMatch) {
      const shortId = joinMatch[1];
      const chosenSide = joinMatch[2] !== undefined ? parseInt(joinMatch[2], 10) : undefined;
      await ctx.answerCallbackQuery({ text: "Collecting wager..." });
      try {
        const result = await joinGameSession(shortId, telegramId, username, chosenSide);
        if (!result.success) {
          await bot.api.sendMessage(ctx.chat!.id, `@${username ?? telegramId}: ${result.error}`);
          return;
        }
        await refreshLobby(shortId);
        updatePinnedBalance(telegramId, result.txHash);
      } catch (err) {
        console.error("[game] join callback failed:", err);
        await bot.api.sendMessage(ctx.chat!.id, `Failed to process join for @${username ?? telegramId}. Please try again.`);
      }
      return;
    }

    // game_end_{shortId} — show winner selection
    const endMatch = data.match(/^game_end_([a-f0-9]+)$/);
    if (endMatch) {
      const shortId = endMatch[1];
      const session = await getSession(shortId);
      if (!session) return ctx.answerCallbackQuery({ text: "Game not found." });
      if (session.creatorTelegramId !== telegramId) {
        return ctx.answerCallbackQuery({ text: "Only the game creator can end the game." });
      }
      if (session.status !== "active") {
        return ctx.answerCallbackQuery({ text: "Game is not active." });
      }
      const config = getGameConfig(session.gameType)!;
      const kb = new InlineKeyboard();
      if (session.teamBased) {
        const t0 = session.players.filter((p) => p.side === 0).map((p) => (p.username ? `@${p.username}` : "player")).join(", ");
        const t1 = session.players.filter((p) => p.side === 1).map((p) => (p.username ? `@${p.username}` : "player")).join(", ");
        kb.text(`Team 1 (${t0})`, `game_winside_${shortId}_0`).row();
        kb.text(`Team 2 (${t1})`, `game_winside_${shortId}_1`);
      } else {
        for (const player of session.players) {
          const label = player.username ? `@${player.username}` : player.telegramId;
          kb.text(label, `game_winplayer_${shortId}_${player.telegramId}`).row();
        }
      }
      const symbol = await getTokenSymbol();
      const caption = buildLobbyCaption(session, config, symbol).replace("Game in progress!", "Who won?");
      await ctx.editMessageCaption({ caption, parse_mode: "HTML", reply_markup: kb });
      return ctx.answerCallbackQuery();
    }

    // game_winside_{shortId}_{side}
    const winSideMatch = data.match(/^game_winside_([a-f0-9]+)_(\d)$/);
    if (winSideMatch) {
      const shortId = winSideMatch[1];
      const side = parseInt(winSideMatch[2], 10);
      const session = await getSession(shortId);
      if (!session) return ctx.answerCallbackQuery({ text: "Game not found." });
      if (session.creatorTelegramId !== telegramId) {
        return ctx.answerCallbackQuery({ text: "Only the game creator can do this." });
      }
      const config = getGameConfig(session.gameType)!;
      const result = await proposeWinner(shortId, telegramId, { side });
      if (!result.success) return ctx.answerCallbackQuery({ text: result.error });
      await refreshLobby(shortId);
      const updated = await getSession(shortId);
      if (updated) {
        const symbol = await getTokenSymbol();
        await sendVoteDMs(shortId, updated, config, symbol);
      }
      return ctx.answerCallbackQuery({ text: "Vote started!" });
    }

    // game_winplayer_{shortId}_{telegramId}
    const winPlayerMatch = data.match(/^game_winplayer_([a-f0-9]+)_(\d+)$/);
    if (winPlayerMatch) {
      const shortId = winPlayerMatch[1];
      const winnerTid = winPlayerMatch[2];
      const session = await getSession(shortId);
      if (!session) return ctx.answerCallbackQuery({ text: "Game not found." });
      if (session.creatorTelegramId !== telegramId) {
        return ctx.answerCallbackQuery({ text: "Only the game creator can do this." });
      }
      const config = getGameConfig(session.gameType)!;
      const result = await proposeWinner(shortId, telegramId, { telegramId: winnerTid });
      if (!result.success) return ctx.answerCallbackQuery({ text: result.error });
      await refreshLobby(shortId);
      const updated = await getSession(shortId);
      if (updated) {
        const symbol = await getTokenSymbol();
        await sendVoteDMs(shortId, updated, config, symbol);
      }
      return ctx.answerCallbackQuery({ text: "Vote started!" });
    }

    // game_vote_yes_{shortId} / game_vote_no_{shortId}
    const voteYesMatch = data.match(/^game_vote_yes_([a-f0-9]+)$/);
    const voteNoMatch = data.match(/^game_vote_no_([a-f0-9]+)$/);
    if (voteYesMatch || voteNoMatch) {
      const shortId = (voteYesMatch ?? voteNoMatch)![1];
      const approved = !!voteYesMatch;
      const result = await castVote(shortId, telegramId, approved);
      if (!result.success) {
        return ctx.answerCallbackQuery({ text: result.error!, show_alert: true });
      }
      await ctx.answerCallbackQuery({ text: `Vote recorded: ${approved ? "Yes" : "No"}` });

      if (result.resolved && result.approved) {
        try {
          const payout = await payoutWinners(shortId);
          if (payout.success) {
            const lastTx = payout.txHashes[payout.txHashes.length - 1] as Hex;
            for (const wid of payout.winnerIds) updatePinnedBalance(wid, lastTx);
          }
        } catch (err) {
          console.error(`[game] payout failed for #${shortId}:`, err);
        }
      } else if (result.resolved && !result.approved) {
        if (ADMIN_TELEGRAM_ID) {
          const session = await getSession(shortId);
          if (session) {
            const config = getGameConfig(session.gameType)!;
            const symbol = await getTokenSymbol();
            await notifyAdminDispute(shortId, session, config, symbol);
          }
        }
      }
      await refreshLobby(shortId);
      return;
    }

    // game_cancel_{shortId}
    const cancelMatch = data.match(/^game_cancel_([a-f0-9]+)$/);
    if (cancelMatch) {
      const shortId = cancelMatch[1];
      await ctx.answerCallbackQuery({ text: "Cancelling and refunding..." });
      try {
        const result = await cancelGame(shortId, telegramId);
        if (!result.success) {
          await bot.api.sendMessage(ctx.chat!.id, `Cancel failed: ${result.error}`);
          return;
        }
        await refreshLobby(shortId);
        if (result.txHashes.length > 0) {
          const lastTx = result.txHashes[result.txHashes.length - 1];
          for (const pid of result.playerIds) updatePinnedBalance(pid, lastTx);
        }
      } catch (err) {
        console.error("[game] cancel failed:", err);
        await bot.api.sendMessage(ctx.chat!.id, "Failed to cancel game.");
      }
      return;
    }

    // game_switch_{shortId}
    const switchMatch = data.match(/^game_switch_([a-f0-9]+)$/);
    if (switchMatch) {
      const shortId = switchMatch[1];
      try {
        const result = await switchTeam(shortId, telegramId);
        if (!result.success) {
          return ctx.answerCallbackQuery({ text: result.error, show_alert: true });
        }
        await refreshLobby(shortId);
        return ctx.answerCallbackQuery({ text: "Switched team!" });
      } catch (err) {
        console.error("[game] switch team failed:", err);
        return ctx.answerCallbackQuery({ text: "Failed to switch team.", show_alert: true });
      }
    }

    // game_leave_{shortId}
    const leaveMatch = data.match(/^game_leave_([a-f0-9]+)$/);
    if (leaveMatch) {
      const shortId = leaveMatch[1];
      try {
        const result = await leaveGame(shortId, telegramId);
        if (!result.success) {
          return ctx.answerCallbackQuery({ text: result.error, show_alert: true });
        }
        await ctx.answerCallbackQuery({ text: "You left the game. Wager refunded!" });
        await refreshLobby(shortId);
        updatePinnedBalance(telegramId, result.txHash);
      } catch (err) {
        console.error("[game] leave failed:", err);
        await ctx.answerCallbackQuery({ text: "Failed to leave game.", show_alert: true });
      }
      return;
    }

    // game_admin_{shortId}_{winner}
    const adminMatch = data.match(/^game_admin_([a-f0-9]+)_(.+)$/);
    if (adminMatch) {
      if (telegramId !== ADMIN_TELEGRAM_ID) {
        return ctx.answerCallbackQuery({ text: "Only the admin can resolve disputes." });
      }
      const shortId = adminMatch[1];
      const winnerIdentifier = adminMatch[2];
      await ctx.answerCallbackQuery({ text: "Resolving..." });
      try {
        if (winnerIdentifier === "refund") {
          const result = await refundGame(shortId);
          if (!result.success) {
            await ctx.editMessageText(`Refund failed: ${result.error}`);
            return;
          }
          await refreshLobby(shortId);
          await ctx.editMessageText(`Game <b>#${shortId}</b> refunded! All wagers returned.`, { parse_mode: "HTML" });
          if (result.txHashes.length > 0) {
            const lastTx = result.txHashes[result.txHashes.length - 1];
            for (const pid of result.playerIds) updatePinnedBalance(pid, lastTx);
          }
        } else {
          const result = await adminResolveGame(shortId, winnerIdentifier);
          if (!result.success) {
            await ctx.editMessageText(`Resolve failed: ${result.error}`);
            return;
          }
          await refreshLobby(shortId);
          await ctx.editMessageText(`Game <b>#${shortId}</b> resolved! Winnings paid out.`, { parse_mode: "HTML" });
          if (result.success) {
            const lastTx = result.txHashes[result.txHashes.length - 1] as Hex;
            for (const wid of result.winnerIds) updatePinnedBalance(wid, lastTx);
          }
        }
      } catch (err) {
        console.error("[game] admin resolve failed:", err);
        await ctx.editMessageText("Failed to resolve game.");
      }
      return;
    }

    return ctx.answerCallbackQuery({ text: "Unknown action." });
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

      updatePinnedBalance(bounty.creatorTelegramId, result.txHash);
      if (bounty.claimerTelegramId) updatePinnedBalance(bounty.claimerTelegramId, result.txHash);
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

bot.command("task", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply("Could not identify you.");
  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const active = await SelfieTask.findOne({ telegramId, status: "active" });
  if (active) {
    log("task", telegramId, username, `already has active task: "${active.item}"`);
    return ctx.reply(
      `You already have an active task:\n\n📸 <b>Take a selfie with a ${active.item}</b>\n\nSend a photo to complete it!`,
      { parse_mode: "HTML" },
    );
  }

  const completed = await SelfieTask.find({ telegramId, status: "completed" }).select("item").lean();
  const completedItems = new Set(completed.map((t) => t.item));
  const available = SELFIE_TASKS.filter((t) => !completedItems.has(t));

  if (available.length === 0) {
    log("task", telegramId, username, "all tasks completed!");
    return ctx.reply("🎉 You've completed all selfie tasks! Amazing!");
  }

  const item = available[Math.floor(Math.random() * available.length)];
  await SelfieTask.create({ telegramId, item });

  log("task", telegramId, username, `assigned task: "${item}" (${completed.length}/${SELFIE_TASKS.length} done)`);

  await ctx.reply(
    `📸 <b>New Selfie Task!</b>\n\nTake a selfie with a <b>${item}</b>\n\nSend the photo here when you're done!\n\n(${completed.length}/${SELFIE_TASKS.length} tasks completed)`,
    { parse_mode: "HTML" },
  );
});

bot.on("message:photo", async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  syncProfile(ctx.from!);
  const username = ctx.from?.username ?? null;

  const active = await SelfieTask.findOne({ telegramId, status: "active" });
  if (!active) {
    return ctx.reply("You don't have an active task. Use /task to get one!");
  }

  log("photo", telegramId, username, `photo received, verifying task: "${active.item}"`);

  const typing = startTyping(ctx);

  try {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    const file = await ctx.api.getFile(largest.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download photo: ${res.status}`);
    const imageBuffer = await res.arrayBuffer();
    log("photo", telegramId, username, `downloaded ${imageBuffer.byteLength} bytes, verifying...`);

    const result = await verifySelfieWithItem(imageBuffer, active.item);
    typing.stop();

    log("photo", telegramId, username, `verification: verified=${result.verified} person=${result.hasPerson} item=${result.hasItem}`);

    if (result.verified) {
      await SelfieTask.updateOne({ _id: active._id }, { status: "completed", completedAt: new Date() });
      const completedCount = await SelfieTask.countDocuments({ telegramId, status: "completed" });

      await ctx.reply(
        `✅ Task complete! Nice selfie with the ${active.item}!\n\n${result.reasoning}\n\n(${completedCount}/${SELFIE_TASKS.length} tasks done — use /task for the next one!)`,
        { reply_parameters: { message_id: ctx.message.message_id } },
      );
    } else {
      const missing: string[] = [];
      if (!result.hasPerson) missing.push("a person (selfie)");
      if (!result.hasItem) missing.push(`a ${active.item}`);
      await ctx.reply(
        `❌ Not verified. Missing: ${missing.join(" and ")}.\n\n${result.reasoning}\n\nTry again! Your task: selfie with a <b>${active.item}</b>`,
        { reply_parameters: { message_id: ctx.message.message_id }, parse_mode: "HTML" },
      );
    }
  } catch (err) {
    typing.stop();
    log("photo", telegramId, username, `FAILED: ${err}`);
    await ctx.reply("Failed to verify the photo. Please try again later.");
  }
});

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
    { command: "task", description: "Get a selfie task to complete" },
    { command: "games", description: "Play wagered party games" },
  ]);

  console.log("[bot] commands registered");
  console.log(`[bot] chain: ${chain.name} (${chain.id})`);
  console.log(`[bot] token contract: ${TOKEN_CONTRACT_ADDRESS}`);
  console.log(`[bot] admin: ${ADMIN_TELEGRAM_ID || "none"}`);
  console.log(`[bot] bounty chat: ${BOUNTY_CHAT_ID || "none"}`);
  console.log(`[bot] games chat: ${GAMES_CHAT_ID || "(uses current chat)"}`);
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
