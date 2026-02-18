import mongoose, { Schema, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, index: true },
  displayName: { type: String },
  smartAccountAddress: { type: String, required: true },
  privateKey: { type: String, required: true },
  isDeployed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

export type IUser = InferSchemaType<typeof userSchema>;
export const User = mongoose.model("User", userSchema);
