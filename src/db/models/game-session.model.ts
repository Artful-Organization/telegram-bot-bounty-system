import mongoose, { Schema, type InferSchemaType } from "mongoose";

const gamePlayerSchema = new Schema(
  {
    telegramId: { type: String, required: true },
    username: { type: String },
    side: { type: Number, default: 0 },
    paid: { type: Boolean, default: false },
  },
  { _id: false },
);

const gameVoteSchema = new Schema(
  {
    telegramId: { type: String, required: true },
    approved: { type: Boolean, required: true },
  },
  { _id: false },
);

const gameSessionSchema = new Schema({
  shortId: { type: String, required: true, unique: true, index: true },
  gameType: { type: String, required: true },
  creatorTelegramId: { type: String, required: true, index: true },
  wagerPerPlayer: { type: String, required: true },
  totalSlots: { type: Number, required: true },
  teamBased: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ["waiting", "active", "voting", "completed", "cancelled", "disputed"],
    default: "waiting",
  },
  players: { type: [gamePlayerSchema], default: [] },
  proposedWinnerSide: { type: Number, default: null },
  proposedWinnerTelegramId: { type: String, default: null },
  votes: { type: [gameVoteSchema], default: [] },
  lobbyMessageId: { type: Number, default: null },
  lobbyChatId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date },
});

gameSessionSchema.index({ status: 1 });

export type IGameSession = InferSchemaType<typeof gameSessionSchema>;
export const GameSession = mongoose.model("GameSession", gameSessionSchema);
