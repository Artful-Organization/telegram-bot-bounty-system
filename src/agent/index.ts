import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from "../config.js";
import { ChatMessage } from "../db/models/chat-message.model.js";
import { buildTools, type ToolContext } from "./tools.js";

const llm = new ChatOpenAI({
  model: OPENROUTER_MODEL,
  apiKey: OPENROUTER_API_KEY,
  configuration: { baseURL: "https://openrouter.ai/api/v1" },
});

const BASE_SYSTEM_PROMPT =
  "You are a helpful wallet assistant for a Telegram-based token transfer bot. " +
  "You can look up registered users, transfer tokens, and manage bounties on behalf of the user. " +
  "When the user asks to send money, extract the recipient username and amount, then use the transfer_money tool. " +
  "When the user asks about users or wallets, use the get_users tool. " +
  "When the user wants to post a bounty/task with a reward, use the create_bounty tool. " +
  "When the user wants to see available bounties, use the list_bounties tool. " +
  "When the user wants to claim a bounty they completed, use the claim_bounty tool. " +
  "When the user wants to cancel their own bounty, use the cancel_bounty tool. " +
  "IMPORTANT: If you are not sure which user to send money to, assign a bounty to, or perform any action for, " +
  "you MUST ask for clarification before proceeding. Never guess — ask the user to specify the exact username or person. " +
  "If a search returns multiple matching users, list them and ask which one they mean. " +
  "Keep responses concise and friendly.";

async function loadChatHistory(chatId: string) {
  const rows = await ChatMessage.find({ chatId })
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  rows.reverse();

  return rows.map((m) => {
    if (m.isBot) return new AIMessage(m.text);
    const tag = m.senderUsername
      ? `@${m.senderUsername}`
      : m.senderDisplayName ?? "Unknown";
    return new HumanMessage(`[${tag}]: ${m.text}`);
  });
}

export async function invokeAgent(
  chatId: string,
  ctx: ToolContext,
): Promise<string> {
  const tools = buildTools(ctx);
  const history = await loadChatHistory(chatId);

  const userTag = ctx.senderUsername ? `@${ctx.senderUsername}` : ctx.senderDisplayName;
  const chatType = chatId.startsWith("-") ? "a group chat" : "a private chat";
  const systemPrompt =
    `${BASE_SYSTEM_PROMPT}\n\n` +
    `You are in ${chatType} with ${userTag} (Telegram ID: ${ctx.senderTelegramId}). ` +
    `All tools that act on behalf of "the current user" will operate as this person.`;

  const agent = createAgent({
    model: llm,
    tools,
    systemPrompt,
  });

  const result = await agent.invoke({
    messages: history,
  });

  const lastMessage = result.messages.at(-1);
  if (lastMessage instanceof AIMessage && typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  return "Sorry, I couldn't process that request.";
}
