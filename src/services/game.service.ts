import crypto from "node:crypto";
import { parseUnits, type Hex } from "viem";
import { GameSession } from "../db/models/game-session.model.js";
import { User } from "../db/models/user.model.js";
import { OWNER_PRIVATE_KEY, OWNER_SAFE_ADDRESS } from "../config.js";
import {
  getTokenBalance,
  getTokenDecimals,
  getTokenSymbol,
  sendTokens,
  formatBalance,
} from "./transfer.service.js";

export interface GameConfig {
  id: string;
  name: string;
  emoji: string;
  teamBased: boolean;
  playerOptions: number[];
  description: string;
}

export const GAME_CONFIGS: GameConfig[] = [
  {
    id: "beer_pong",
    name: "Beer Pong",
    emoji: "\u{1F37A}",
    teamBased: true,
    playerOptions: [2, 4, 6, 8],
    description: "Classic beer pong",
  },
  {
    id: "blackjack",
    name: "Black Jack",
    emoji: "\u{1F0CF}",
    teamBased: false,
    playerOptions: [2, 3, 4, 5, 6, 7, 8],
    description: "Beat the dealer",
  },
  {
    id: "connect_4",
    name: "Connect 4",
    emoji: "\u{1F534}",
    teamBased: false,
    playerOptions: [2],
    description: "Get 4 in a row",
  },
  {
    id: "darts",
    name: "Darts",
    emoji: "\u{1F3AF}",
    teamBased: false,
    playerOptions: [2, 3, 4],
    description: "Hit the bullseye",
  },
  {
    id: "flip_cup",
    name: "Flip Cup",
    emoji: "\u{1F964}",
    teamBased: true,
    playerOptions: [4, 6, 8],
    description: "Flip it fast",
  },
];

export const WAGER_OPTIONS = ["5", "10", "25", "50", "100"];

export function getGameConfig(gameType: string): GameConfig | undefined {
  return GAME_CONFIGS.find((g) => g.id === gameType);
}

function generateShortId(): string {
  return crypto.randomBytes(3).toString("hex");
}

export type CreateGameResult =
  | { success: true; shortId: string; txHash: Hex }
  | { success: false; error: string };

export async function createGameSession(
  gameType: string,
  creatorTelegramId: string,
  creatorUsername: string | null,
  totalSlots: number,
  wagerPerPlayer: string,
): Promise<CreateGameResult> {
  const config = getGameConfig(gameType);
  if (!config) return { success: false, error: "Unknown game type." };
  if (!config.playerOptions.includes(totalSlots)) {
    return { success: false, error: "Invalid player count for this game." };
  }

  const creator = await User.findOne({ telegramId: creatorTelegramId });
  if (!creator) {
    return { success: false, error: "You don't have a wallet yet. Use /start first." };
  }

  const decimals = await getTokenDecimals();
  const wagerWei = parseUnits(wagerPerPlayer, decimals);
  const balance = await getTokenBalance(creator.smartAccountAddress as Hex);
  if (balance < wagerWei) {
    const formatted = await formatBalance(creator.smartAccountAddress as Hex);
    return { success: false, error: `Insufficient balance. You have ${formatted}.` };
  }

  console.log(`[game] collecting wager from creator ${creatorTelegramId}: ${wagerPerPlayer} tokens`);
  const txHash = await sendTokens(creator.privateKey as Hex, OWNER_SAFE_ADDRESS, wagerWei);
  await User.updateOne({ telegramId: creatorTelegramId }, { isDeployed: true });

  let shortId = generateShortId();
  while (await GameSession.exists({ shortId })) {
    shortId = generateShortId();
  }

  await GameSession.create({
    shortId,
    gameType,
    creatorTelegramId,
    wagerPerPlayer,
    totalSlots,
    teamBased: config.teamBased,
    players: [
      {
        telegramId: creatorTelegramId,
        username: creatorUsername ?? undefined,
        side: 0,
        paid: true,
      },
    ],
  });

  console.log(`[game] created session #${shortId}: ${config.name} ${totalSlots} players, ${wagerPerPlayer}/player`);
  return { success: true, shortId, txHash };
}

export type JoinGameResult =
  | { success: true; isFull: boolean; txHash: Hex }
  | { success: false; error: string };

export async function joinGameSession(
  shortId: string,
  telegramId: string,
  username: string | null,
  chosenSide?: number,
): Promise<JoinGameResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.status !== "waiting") {
    return { success: false, error: "This game is no longer accepting players." };
  }
  if (session.players.some((p) => p.telegramId === telegramId)) {
    return { success: false, error: "You already joined this game." };
  }
  if (session.players.length >= session.totalSlots) {
    return { success: false, error: "This game is full." };
  }

  let side = 0;
  if (session.teamBased) {
    const slotsPerSide = session.totalSlots / 2;
    const side0Count = session.players.filter((p) => p.side === 0).length;
    const side1Count = session.players.filter((p) => p.side === 1).length;

    if (chosenSide === 0 || chosenSide === 1) {
      const count = chosenSide === 0 ? side0Count : side1Count;
      if (count >= slotsPerSide) {
        return { success: false, error: `Team ${chosenSide + 1} is full.` };
      }
      side = chosenSide;
    } else {
      side = side0Count <= side1Count ? 0 : 1;
    }
  }

  const user = await User.findOne({ telegramId });
  if (!user) {
    return { success: false, error: "You don't have a wallet yet. Use /start first." };
  }

  const decimals = await getTokenDecimals();
  const wagerWei = parseUnits(session.wagerPerPlayer, decimals);
  const balance = await getTokenBalance(user.smartAccountAddress as Hex);
  if (balance < wagerWei) {
    const formatted = await formatBalance(user.smartAccountAddress as Hex);
    return { success: false, error: `Insufficient balance. You have ${formatted}.` };
  }

  console.log(`[game] collecting wager from joiner ${telegramId}: ${session.wagerPerPlayer} tokens`);
  const txHash = await sendTokens(user.privateKey as Hex, OWNER_SAFE_ADDRESS, wagerWei);
  await User.updateOne({ telegramId }, { isDeployed: true });

  const isFull = session.players.length + 1 >= session.totalSlots;

  await GameSession.updateOne(
    { shortId },
    {
      $push: {
        players: { telegramId, username: username ?? undefined, side, paid: true },
      },
      ...(isFull ? { status: "active", startedAt: new Date() } : {}),
    },
  );

  console.log(`[game] ${telegramId} joined #${shortId} (${session.players.length + 1}/${session.totalSlots})${isFull ? " — game started" : ""}`);
  return { success: true, isFull, txHash };
}

export async function getSession(shortId: string) {
  return GameSession.findOne({ shortId }).lean();
}

export type ProposeWinnerResult =
  | { success: true }
  | { success: false; error: string };

export async function proposeWinner(
  shortId: string,
  telegramId: string,
  winner: { side: number } | { telegramId: string },
): Promise<ProposeWinnerResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.creatorTelegramId !== telegramId) {
    return { success: false, error: "Only the game creator can end the game." };
  }
  if (session.status !== "active") {
    return { success: false, error: "This game is not active." };
  }

  const update: Record<string, unknown> = { status: "voting", votes: [] };
  if ("side" in winner) {
    update.proposedWinnerSide = winner.side;
    update.proposedWinnerTelegramId = null;
  } else {
    update.proposedWinnerTelegramId = winner.telegramId;
    update.proposedWinnerSide = null;
  }

  await GameSession.updateOne({ shortId }, update);
  console.log(`[game] #${shortId} winner proposed: ${JSON.stringify(winner)}`);
  return { success: true };
}

export interface VoteResult {
  success: boolean;
  error?: string;
  totalVotes: number;
  approvals: number;
  denials: number;
  resolved: boolean;
  approved: boolean;
}

export async function castVote(
  shortId: string,
  telegramId: string,
  approved: boolean,
): Promise<VoteResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found.", totalVotes: 0, approvals: 0, denials: 0, resolved: false, approved: false };
  if (session.status !== "voting") {
    return { success: false, error: "This game is not in voting.", totalVotes: 0, approvals: 0, denials: 0, resolved: false, approved: false };
  }
  if (!session.players.some((p) => p.telegramId === telegramId)) {
    return { success: false, error: "Only players can vote.", totalVotes: 0, approvals: 0, denials: 0, resolved: false, approved: false };
  }
  if (session.votes.some((v) => v.telegramId === telegramId)) {
    return { success: false, error: "You already voted.", totalVotes: 0, approvals: 0, denials: 0, resolved: false, approved: false };
  }

  await GameSession.updateOne(
    { shortId },
    { $push: { votes: { telegramId, approved } } },
  );

  const totalPlayers = session.players.length;
  const newVotes = [...session.votes, { telegramId, approved }];
  const approvals = newVotes.filter((v) => v.approved).length;
  const denials = newVotes.filter((v) => !v.approved).length;
  const majority = Math.floor(totalPlayers / 2) + 1;

  const isApproved = approvals >= majority;
  const isDenied = denials >= majority;
  const resolved = isApproved || isDenied;

  if (isApproved) {
    await GameSession.updateOne({ shortId }, { status: "completed", completedAt: new Date() });
  } else if (isDenied) {
    await GameSession.updateOne({ shortId }, { status: "disputed" });
  }

  console.log(`[game] #${shortId} vote: ${approved ? "yes" : "no"} by ${telegramId} (${approvals}/${denials}/${totalPlayers})`);
  return { success: true, totalVotes: newVotes.length, approvals, denials, resolved, approved: isApproved };
}

export type PayoutResult =
  | { success: true; txHashes: string[]; winnerIds: string[] }
  | { success: false; error: string };

export async function payoutWinners(shortId: string): Promise<PayoutResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.status !== "completed") {
    return { success: false, error: "Game is not completed." };
  }

  let winnerIds: string[];
  if (session.teamBased && session.proposedWinnerSide !== null && session.proposedWinnerSide !== undefined) {
    winnerIds = session.players
      .filter((p) => p.side === session.proposedWinnerSide)
      .map((p) => p.telegramId);
  } else if (session.proposedWinnerTelegramId) {
    winnerIds = [session.proposedWinnerTelegramId];
  } else {
    return { success: false, error: "No winner specified." };
  }

  if (winnerIds.length === 0) return { success: false, error: "No winners found." };

  const decimals = await getTokenDecimals();
  const wagerWei = parseUnits(session.wagerPerPlayer, decimals);
  const totalPot = wagerWei * BigInt(session.players.length);
  const perWinner = totalPot / BigInt(winnerIds.length);

  const winners = await User.find({ telegramId: { $in: winnerIds } }).lean();
  if (winners.length === 0) return { success: false, error: "Winner accounts not found." };

  const txHashes: string[] = [];
  for (const winner of winners) {
    console.log(`[game] #${shortId} paying ${perWinner} to ${winner.smartAccountAddress}`);
    const txHash = await sendTokens(OWNER_PRIVATE_KEY, winner.smartAccountAddress as Hex, perWinner);
    txHashes.push(txHash);
  }

  console.log(`[game] #${shortId} payout complete: ${txHashes.length} transfers`);
  return { success: true, txHashes, winnerIds };
}

export type RefundResult =
  | { success: true; count: number; txHashes: Hex[]; playerIds: string[] }
  | { success: false; error: string };

export async function refundGame(shortId: string): Promise<RefundResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };

  const paidPlayers = session.players.filter((p) => p.paid);
  if (paidPlayers.length === 0) return { success: true, count: 0, txHashes: [], playerIds: [] };

  const decimals = await getTokenDecimals();
  const wagerWei = parseUnits(session.wagerPerPlayer, decimals);

  const users = await User.find({
    telegramId: { $in: paidPlayers.map((p) => p.telegramId) },
  }).lean();

  const txHashes: Hex[] = [];
  for (const user of users) {
    console.log(`[game] #${shortId} refunding ${session.wagerPerPlayer} to ${user.smartAccountAddress}`);
    const txHash = await sendTokens(OWNER_PRIVATE_KEY, user.smartAccountAddress as Hex, wagerWei);
    txHashes.push(txHash);
  }

  await GameSession.updateOne({ shortId }, { status: "cancelled" });
  console.log(`[game] #${shortId} refunded ${users.length} players`);
  return { success: true, count: users.length, txHashes, playerIds: users.map((u) => u.telegramId) };
}

export async function cancelGame(
  shortId: string,
  telegramId: string,
): Promise<RefundResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.creatorTelegramId !== telegramId) {
    return { success: false, error: "Only the game creator can cancel." };
  }
  if (session.status !== "waiting") {
    return { success: false, error: "Can only cancel games that haven't started." };
  }

  return refundGame(shortId);
}

export async function adminResolveGame(
  shortId: string,
  winnerIdentifier: string,
): Promise<PayoutResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.status !== "disputed") {
    return { success: false, error: "Game is not disputed." };
  }

  if (session.teamBased) {
    const side = parseInt(winnerIdentifier, 10);
    if (isNaN(side) || (side !== 0 && side !== 1)) {
      return { success: false, error: "Invalid side." };
    }
    await GameSession.updateOne({ shortId }, {
      proposedWinnerSide: side,
      proposedWinnerTelegramId: null,
      status: "completed",
      completedAt: new Date(),
    });
  } else {
    if (!session.players.some((p) => p.telegramId === winnerIdentifier)) {
      return { success: false, error: "Winner is not a player in this game." };
    }
    await GameSession.updateOne({ shortId }, {
      proposedWinnerTelegramId: winnerIdentifier,
      proposedWinnerSide: null,
      status: "completed",
      completedAt: new Date(),
    });
  }

  return payoutWinners(shortId);
}

export type SwitchTeamResult =
  | { success: true }
  | { success: false; error: string };

export async function switchTeam(
  shortId: string,
  telegramId: string,
): Promise<SwitchTeamResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.status !== "waiting") {
    return { success: false, error: "Can only switch teams before the game starts." };
  }
  if (!session.teamBased) {
    return { success: false, error: "This game doesn't have teams." };
  }

  const player = session.players.find((p) => p.telegramId === telegramId);
  if (!player) return { success: false, error: "You haven't joined this game." };

  const newSide = player.side === 0 ? 1 : 0;
  const slotsPerSide = session.totalSlots / 2;
  const newSideCount = session.players.filter((p) => p.side === newSide).length;
  if (newSideCount >= slotsPerSide) {
    return { success: false, error: `Team ${newSide + 1} is full.` };
  }

  await GameSession.updateOne(
    { shortId, "players.telegramId": telegramId },
    { $set: { "players.$.side": newSide } },
  );

  console.log(`[game] ${telegramId} switched to team ${newSide + 1} in #${shortId}`);
  return { success: true };
}

export type LeaveGameResult =
  | { success: true; txHash: Hex }
  | { success: false; error: string };

export async function leaveGame(
  shortId: string,
  telegramId: string,
): Promise<LeaveGameResult> {
  const session = await GameSession.findOne({ shortId });
  if (!session) return { success: false, error: "Game not found." };
  if (session.status !== "waiting") {
    return { success: false, error: "Can only leave before the game starts." };
  }

  const player = session.players.find((p) => p.telegramId === telegramId);
  if (!player) return { success: false, error: "You haven't joined this game." };

  if (session.creatorTelegramId === telegramId) {
    return { success: false, error: "The game creator can't leave. Use cancel instead." };
  }

  const user = await User.findOne({ telegramId });
  if (!user) return { success: false, error: "User not found." };

  const decimals = await getTokenDecimals();
  const wagerWei = parseUnits(session.wagerPerPlayer, decimals);

  console.log(`[game] refunding ${session.wagerPerPlayer} to ${telegramId} for leaving #${shortId}`);
  const txHash = await sendTokens(OWNER_PRIVATE_KEY, user.smartAccountAddress as Hex, wagerWei);

  await GameSession.updateOne(
    { shortId },
    { $pull: { players: { telegramId } } },
  );

  console.log(`[game] ${telegramId} left #${shortId}`);
  return { success: true, txHash };
}

export function formatPlayerLabel(
  session: { teamBased: boolean; totalSlots: number },
  config: GameConfig,
): string {
  if (config.teamBased) {
    const perSide = session.totalSlots / 2;
    return `${perSide}v${perSide}`;
  }
  return `${session.totalSlots} players`;
}
