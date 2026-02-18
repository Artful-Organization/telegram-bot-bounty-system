import mongoose, { Schema, type InferSchemaType } from "mongoose";

const chatMessageSchema = new Schema({
  chatId: { type: String, required: true },
  messageId: { type: Number, required: true },
  senderTelegramId: { type: String, required: true },
  senderUsername: { type: String },
  senderDisplayName: { type: String },
  isBot: { type: Boolean, default: false },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

chatMessageSchema.index({ chatId: 1, createdAt: -1 });
chatMessageSchema.index({ chatId: 1, messageId: 1 }, { unique: true });

export type IChatMessage = InferSchemaType<typeof chatMessageSchema>;
export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
