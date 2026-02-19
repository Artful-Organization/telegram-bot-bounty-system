import mongoose from "mongoose";
import { MONGODB_URI } from "../config.js";

export async function connectDB() {
  console.log("[db] connecting to MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("[db] connected to MongoDB");
}
