import { FIREWORKS_API_KEY } from "../config.js";

const WHISPER_ENDPOINT = "https://audio-turbo.us-virginia-1.direct.fireworks.ai";
const WHISPER_MODEL = "whisper-v3-turbo";

export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  mimeType = "audio/ogg",
): Promise<string> {
  console.log(`[transcribe] starting transcription (${audioBuffer.byteLength} bytes, ${mimeType})`);
  const ext = mimeType.split("/")[1] || "ogg";
  const blob = new Blob([audioBuffer], { type: mimeType });

  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", WHISPER_MODEL);
  form.append("vad_model", "silero");
  form.append("alignment_model", "tdnn_ffn");
  form.append("preprocessing", "dynamic");
  form.append("temperature", "0");
  form.append("language", "en");

  const start = Date.now();
  const res = await fetch(`${WHISPER_ENDPOINT}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FIREWORKS_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[transcribe] FAILED (${res.status}) in ${Date.now() - start}ms: ${body}`);
    throw new Error(`Transcription failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim() ?? "";
  console.log(`[transcribe] done in ${Date.now() - start}ms: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
  return text;
}
