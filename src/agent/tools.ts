import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { User } from "../db/models/user.model.js";
import { validateTransfer, getTokenSymbol } from "../services/transfer.service.js";
import {
  createBounty,
  listOpenBounties,
  claimBounty,
  cancelBounty,
} from "../services/bounty.service.js";
import { Bounty } from "../db/models/bounty.model.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type NotifyRecipientFn = (
  recipientTelegramId: string,
  senderUsername: string | null,
  amountStr: string,
  txHash: string,
) => Promise<void>;

export type NotifyBountyClaimFn = (
  creatorTelegramId: string,
  claimerUsername: string | null,
  bountyShortId: string,
  bountyDescription: string,
  bountyAmount: string,
  symbol: string,
) => Promise<void>;

export type NotifySenderFn = (
  senderTelegramId: string,
  recipientUsername: string | null,
  amountStr: string,
  txHash: string,
) => Promise<void>;

export type PostBountyFn = (bountyMessage: string) => Promise<void>;

export type RequestTransferConfirmFn = (
  recipientUsername: string,
  amount: string,
  symbol: string,
) => Promise<void>;

export interface ToolContext {
  senderTelegramId: string;
  senderUsername: string | null;
  senderDisplayName: string;
  notifyRecipient: NotifyRecipientFn;
  notifySender: NotifySenderFn;
  notifyBountyCreator: NotifyBountyClaimFn;
  postBounty: PostBountyFn;
  requestTransferConfirm: RequestTransferConfirmFn;
}

const getUsersTool = tool(
  async ({ search }) => {
    const filter = search
      ? {
          $or: [
            { telegramId: search },
            { username: { $regex: new RegExp(escapeRegex(search), "i") } },
            { displayName: { $regex: new RegExp(escapeRegex(search), "i") } },
          ],
        }
      : {};

    const users = await User.find(filter)
      .select("-privateKey -__v")
      .lean();

    if (users.length === 0) {
      return search
        ? `No user found matching "${search}".`
        : "No users registered yet.";
    }

    return JSON.stringify(users);
  },
  {
    name: "get_users",
    description:
      "Search registered users by Telegram ID, username, or display name (partial, case-insensitive). " +
      "Omit search to list all users. " +
      "Returns telegramId, username, displayName, smartAccountAddress, isDeployed, and createdAt.",
    schema: z.object({
      search: z
        .string()
        .optional()
        .describe("Search by Telegram ID (exact), or username/display name (case-insensitive, partial match). Don't use @ prefix."),
    }),
  },
);

function createTransferTool(ctx: ToolContext) {
  return tool(
    async ({ recipientUsername, amount: amountStr }) => {
      const validation = await validateTransfer(ctx.senderTelegramId, recipientUsername, amountStr);
      if (!validation.success) return validation.error;

      await ctx.requestTransferConfirm(recipientUsername, amountStr, validation.symbol);

      return `Transfer of ${amountStr} $${validation.symbol} to @${recipientUsername} requires confirmation. A confirmation prompt has been sent — the user must tap Confirm or Cancel. Do NOT tell the user the transfer is complete.`;
    },
    {
      name: "transfer_money",
      description:
        "Transfer tokens from the current user's wallet to another user by username. " +
        "The sender is the user who initiated the conversation. " +
        "This will send a confirmation prompt — the transfer is NOT executed immediately.",
      schema: z.object({
        recipientUsername: z
          .string()
          .describe("The recipient's Telegram username (without @)."),
        amount: z
          .string()
          .describe("The amount of tokens to send (e.g. \"10\", \"0.5\")."),
      }),
    },
  );
}

function createBountyTool(ctx: ToolContext) {
  return tool(
    async ({ description, amount }) => {
      const result = await createBounty(ctx.senderTelegramId, description, amount);
      if (!result.success) return result.error;

      const { bounty } = result;
      const symbol = await getTokenSymbol();
      const user = await User.findOne({ telegramId: ctx.senderTelegramId });
      const poster = user?.username ? `@${user.username}` : (user?.displayName ?? "Someone");

      const bountyMsg =
        `<b>Bounty #${bounty.shortId}</b>\n\n` +
        `${description}\n\n` +
        `Reward: <b>${amount} $${symbol}</b>\n` +
        `Posted by: ${poster}\n\n` +
        `To claim: <code>/claim ${bounty.shortId}</code>`;

      await ctx.postBounty(bountyMsg);

      return `Bounty #${bounty.shortId} created! "${description}" for ${amount} $${symbol}. Others can claim it with /claim ${bounty.shortId}`;
    },
    {
      name: "create_bounty",
      description:
        "Create a new bounty with a reward. The current user will pay the reward when someone completes it.",
      schema: z.object({
        description: z.string().describe("What needs to be done."),
        amount: z.string().describe("The token reward amount (e.g. \"50\", \"10.5\")."),
      }),
    },
  );
}

function createListBountiesTool(ctx: ToolContext) {
  return tool(
    async ({ search }) => {
      const bounties = await listOpenBounties(search);
      if (bounties.length === 0) {
        return search
          ? `No open bounties matching "${search}".`
          : "No open bounties right now.";
      }

      const symbol = await getTokenSymbol();
      const lines = bounties.map((b) => {
        const poster = b.creatorUsername ? `@${b.creatorUsername}` : (b.creatorDisplayName ?? "Unknown");
        return `#${b.shortId} — ${b.amount} $${symbol}: ${b.description} (by ${poster})`;
      });
      return lines.join("\n");
    },
    {
      name: "list_bounties",
      description:
        "List open bounties. Can optionally search by creator username, display name, or bounty description.",
      schema: z.object({
        search: z
          .string()
          .optional()
          .describe("Search term to filter bounties by creator username, display name, or description (case-insensitive, partial match)."),
      }),
    },
  );
}

function createClaimBountyTool(ctx: ToolContext) {
  return tool(
    async ({ bountyId }) => {
      const result = await claimBounty(bountyId, ctx.senderTelegramId);
      if (!result.success) return result.error;

      const bounty = await Bounty.findOne({ shortId: bountyId });
      if (!bounty) return "Bounty not found.";

      const claimer = await User.findOne({ telegramId: ctx.senderTelegramId });
      const symbol = await getTokenSymbol();

      await ctx.notifyBountyCreator(
        bounty.creatorTelegramId,
        claimer?.username ?? null,
        bounty.shortId,
        bounty.description,
        bounty.amount,
        symbol,
      );

      return `Claim submitted for bounty #${bountyId}! The bounty creator has been notified and will review your claim.`;
    },
    {
      name: "claim_bounty",
      description:
        "Claim a bounty by its ID, indicating you have completed the task. " +
        "The bounty creator will be notified and can confirm or deny the claim.",
      schema: z.object({
        bountyId: z.string().describe("The short ID of the bounty to claim (e.g. \"a3f9x2\")."),
      }),
    },
  );
}

function createCancelBountyTool(ctx: ToolContext) {
  return tool(
    async ({ bountyId }) => {
      const result = await cancelBounty(bountyId, ctx.senderTelegramId);
      if (!result.success) return result.error!;
      return `Bounty #${bountyId} has been cancelled.`;
    },
    {
      name: "cancel_bounty",
      description: "Cancel a bounty you created. Only the creator can cancel it.",
      schema: z.object({
        bountyId: z.string().describe("The short ID of the bounty to cancel."),
      }),
    },
  );
}

export function buildTools(ctx: ToolContext) {
  return [
    getUsersTool,
    createTransferTool(ctx),
    createBountyTool(ctx),
    createListBountiesTool(ctx),
    createClaimBountyTool(ctx),
    createCancelBountyTool(ctx),
  ];
}
