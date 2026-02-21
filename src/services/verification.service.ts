import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from "../config.js";

const llm = new ChatOpenAI({
  model: OPENROUTER_MODEL,
  apiKey: OPENROUTER_API_KEY,
  configuration: { baseURL: "https://openrouter.ai/api/v1" },
  temperature: 0,
});

export interface VerificationResult {
  verified: boolean;
  hasPerson: boolean;
  hasItem: boolean;
  reasoning: string;
}

export async function verifySelfieWithItem(
  imageBuffer: ArrayBuffer,
  itemDescription: string,
): Promise<VerificationResult> {
  const base64 = Buffer.from(imageBuffer).toString("base64");
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const systemPrompt = new SystemMessage(
    `You are an image verification assistant. You will be shown a photo and must determine whether it satisfies a task. ` +
    `Respond ONLY with valid JSON, no markdown fences, no extra text. ` +
    `Schema: { "hasPerson": boolean, "hasItem": boolean, "verified": boolean, "reasoning": string }. ` +
    `"verified" must be true ONLY if both "hasPerson" and "hasItem" are true.`,
  );

  const userMessage = new HumanMessage({
    content: [
      {
        type: "text",
        text: `Task: "Take a selfie with a ${itemDescription}". Does this photo show a person (selfie) AND a ${itemDescription}? Return the JSON verdict.`,
      },
      {
        type: "image_url",
        image_url: { url: dataUrl },
      },
    ],
  });

  console.log(`[verify] sending image to LLM for verification (item="${itemDescription}")`);
  const start = Date.now();

  const response = await llm.invoke([systemPrompt, userMessage]);
  const elapsed = Date.now() - start;
  const text = typeof response.content === "string" ? response.content : "";
  console.log(`[verify] LLM responded in ${elapsed}ms: ${text.slice(0, 200)}`);

  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      verified: !!parsed.verified,
      hasPerson: !!parsed.hasPerson,
      hasItem: !!parsed.hasItem,
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    console.error("[verify] failed to parse LLM response:", text);
    return {
      verified: false,
      hasPerson: false,
      hasItem: false,
      reasoning: "Failed to analyze the image. Please try again.",
    };
  }
}
