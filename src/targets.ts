import {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "openclaw/plugin-sdk";
import { stripSignalChannelPrefix } from "./constants.js";

export function normalizeSignalCustomMessagingTarget(raw: string): string | undefined {
  return normalizeSignalMessagingTarget(stripSignalChannelPrefix(raw));
}

export function looksLikeSignalCustomTargetId(raw: string, normalized?: string): boolean {
  const rawNormalized = stripSignalChannelPrefix(raw);
  const normalizedTarget = normalized
    ? normalizeSignalCustomMessagingTarget(normalized) ?? stripSignalChannelPrefix(normalized)
    : undefined;
  return looksLikeSignalTargetId(rawNormalized, normalizedTarget);
}
