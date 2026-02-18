import mongoose, { Schema, type InferSchemaType } from "mongoose";

const bountySchema = new Schema({
  shortId: { type: String, required: true, unique: true, index: true },
  creatorTelegramId: { type: String, required: true, index: true },
  description: { type: String, required: true },
  amount: { type: String, required: true },
  status: {
    type: String,
    enum: ["open", "claimed", "completed", "cancelled"],
    default: "open",
  },
  claimerTelegramId: { type: String },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
});

export type IBounty = InferSchemaType<typeof bountySchema>;
export const Bounty = mongoose.model("Bounty", bountySchema);
