import mongoose, { Schema, type InferSchemaType } from "mongoose";

export const SELFIE_TASKS = [
  "Buddha statue",
  "coffee machine",
  "ginger guy",
  "head statue",
  "Connect 4 game",
  "fireplace",
] as const;

export type SelfieTaskItem = (typeof SELFIE_TASKS)[number];

const selfieTaskSchema = new Schema({
  telegramId: { type: String, required: true, index: true },
  item: { type: String, required: true, enum: SELFIE_TASKS },
  status: { type: String, required: true, enum: ["active", "completed"], default: "active" },
  assignedAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
});

selfieTaskSchema.index({ telegramId: 1, status: 1 });

export type ISelfieTask = InferSchemaType<typeof selfieTaskSchema>;
export const SelfieTask = mongoose.model("SelfieTask", selfieTaskSchema);
