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

const BASE_SYSTEM_PROMPT = `You are the Artful Token Bot 🎨 — the house treasurer for The Artful House at ETH Denver.

PERSONALITY:
- Quick, casual replies — this is a party house, not a bank
- Funny and sassy! Don't be a boring corporate bot — make people laugh
- Roast people (gently) when they're broke
- Celebrate big transfers and milestones
- Channel chaotic hype house energy with a crypto twist
- ALWAYS write "ART 🎨" (never naked "ART")

TOKEN INFO:
- Symbol: ART 🎨
- Total Supply: 10,000 (fixed, capped)
- Chain: Base

TOOLS:
- When the user asks to send money, use the transfer_money tool
- The transfer_money tool sends a confirmation prompt — do NOT say the transfer is complete
- Use get_users to look up users by username or name
- Use get_balance to check token balances on-chain
- Use create_bounty to post tasks with rewards
- Use list_bounties to see open bounties
- Use claim_bounty when someone completed a task
- Use cancel_bounty to cancel your own bounty

IMPORTANT:
- If unsure which user, ASK for clarification — never guess
- If search returns multiple users, list them and ask which one
- Keep responses SHORT and punchy
- DO NOT MAKE THINGS UP`;

async function loadChatHistory(chatId: string) {
  console.log(`[agent] loading chat history for chat=${chatId}`);
  const rows = await ChatMessage.find({ chatId })
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  rows.reverse();
  console.log(`[agent] loaded ${rows.length} messages from history`);

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
  replyToText?: string,
): Promise<string> {
  const userTag = ctx.senderUsername ? `@${ctx.senderUsername}` : ctx.senderDisplayName;
  console.log(`[agent] invokeAgent: chat=${chatId} user=${userTag} (${ctx.senderTelegramId})${replyToText ? ` replyTo="${replyToText.slice(0, 80)}"` : ""}`);

  const tools = buildTools(ctx);
  const history = await loadChatHistory(chatId);

  const chatType = chatId.startsWith("-") ? "a group chat" : "a private chat";
  let systemPrompt =
    `${BASE_SYSTEM_PROMPT}\n\n` +
    `You are in ${chatType} with ${userTag} (Telegram ID: ${ctx.senderTelegramId}). ` +
    `All tools that act on behalf of "the current user" will operate as this person.`;

  if (replyToText) {
    systemPrompt += `\n\nThe user's current message is a reply to a previous message that said: "${replyToText}". Take this into account when responding.`;
  }

  console.log(`[agent] calling LLM (model=${OPENROUTER_MODEL}, tools=${tools.length}, history=${history.length})...`);
  const start = Date.now();

  const agent = createAgent({
    model: llm,
    tools,
    systemPrompt,
  });

  const AGENT_TIMEOUT_MS = 90_000;
  const result = await Promise.race([
    agent.invoke({ messages: history }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent timed out after 90s")), AGENT_TIMEOUT_MS),
    ),
  ]);

  const elapsed = Date.now() - start;
  console.log(`[agent] LLM responded in ${elapsed}ms (${result.messages.length} messages)`);

  const lastMessage = result.messages.at(-1);
  if (lastMessage instanceof AIMessage && typeof lastMessage.content === "string" && lastMessage.content.trim()) {
    console.log(`[agent] response: "${lastMessage.content.slice(0, 120)}${lastMessage.content.length > 120 ? "..." : ""}"`);
    return lastMessage.content;
  }

  console.log(`[agent] no usable AI response (last message type=${lastMessage?.constructor?.name}, content=${JSON.stringify(lastMessage && "content" in lastMessage ? lastMessage.content : null)})`);
  return "Sorry, I couldn't process that request.";
}
