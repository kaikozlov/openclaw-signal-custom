import { chunkText } from "./runtime-api.js";

export function chunkTextForOutbound(text: string, limit: number): string[] {
  return chunkText(text, limit);
}
