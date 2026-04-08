import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
  type RoutePeer,
} from "./runtime-api.js";
import { SIGNAL_CHANNEL_ID, stripSignalChannelPrefix } from "./constants.js";

function normalizeLowercaseStringOrEmpty(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSignalMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let normalized = trimmed;
  if (normalizeLowercaseStringOrEmpty(normalized).startsWith("signal:")) {
    normalized = normalized.slice(7).trim();
  }
  if (!normalized) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (lower.startsWith("group:")) {
    const id = normalized.slice(6).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("username:")) {
    const id = normalized.slice(9).trim();
    return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = normalized.slice(2).trim();
    return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : undefined;
  }
  if (lower.startsWith("uuid:")) {
    const id = normalized.slice(5).trim();
    return id ? normalizeLowercaseStringOrEmpty(id) : undefined;
  }
  return normalizeLowercaseStringOrEmpty(normalized);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_PATTERN = /^[0-9a-f]{32}$/i;

function looksLikeSignalTargetId(raw: string, normalized?: string): boolean {
  const candidates = [raw, normalized ?? ""].map((value) => value.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (/^(signal:)?(group:|username:|u:)/i.test(candidate)) {
      return true;
    }
    if (/^(signal:)?uuid:/i.test(candidate)) {
      const stripped = candidate.replace(/^signal:/i, "").replace(/^uuid:/i, "").trim();
      if (!stripped) {
        continue;
      }
      if (UUID_PATTERN.test(stripped) || UUID_COMPACT_PATTERN.test(stripped)) {
        return true;
      }
      continue;
    }
    const withoutSignalPrefix = candidate.replace(/^signal:/i, "").trim();
    if (UUID_PATTERN.test(withoutSignalPrefix) || UUID_COMPACT_PATTERN.test(withoutSignalPrefix)) {
      return true;
    }
    if (/^\+?\d{3,}$/.test(withoutSignalPrefix)) {
      return true;
    }
  }
  return false;
}

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

export function inferSignalCustomTargetChatType(rawTo: string): "direct" | "group" | undefined {
  const normalized = normalizeSignalCustomMessagingTarget(rawTo);
  if (!normalized) {
    return undefined;
  }
  return normalized.toLowerCase().startsWith("group:") ? "group" : "direct";
}

export function parseSignalCustomExplicitTarget(raw: string): {
  to: string;
  chatType: "direct" | "group" | undefined;
} | null {
  const normalized = normalizeSignalCustomMessagingTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: inferSignalCustomTargetChatType(normalized),
  };
}

export function resolveSignalCustomCommandConversation(params: {
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const conversationId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = candidate?.trim();
      if (!trimmed) {
        return undefined;
      }
      return normalizeSignalCustomMessagingTarget(trimmed);
    })
    .find((candidate): candidate is string => Boolean(candidate));
  return conversationId ? { conversationId } : null;
}

export function resolveSignalCustomOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
): ChannelOutboundSessionRoute | null {
  let trimmed = stripChannelTargetPrefix(params.target, SIGNAL_CHANNEL_ID, "signal");
  if (!trimmed) {
    return null;
  }
  trimmed = stripSignalChannelPrefix(trimmed);
  if (!trimmed) {
    return null;
  }

  const normalized = normalizeSignalCustomMessagingTarget(trimmed);
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("group:")) {
    const groupId = stripTargetKindPrefix(normalized);
    if (!groupId) {
      return null;
    }
    return buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: SIGNAL_CHANNEL_ID,
      accountId: params.accountId,
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `${SIGNAL_CHANNEL_ID}:group:${groupId}`,
      to: `${SIGNAL_CHANNEL_ID}:group:${groupId}`,
    });
  }

  const peer: RoutePeer = { kind: "direct", id: normalized };
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: SIGNAL_CHANNEL_ID,
    accountId: params.accountId,
    peer,
    chatType: "direct",
    from: `${SIGNAL_CHANNEL_ID}:${normalized}`,
    to: `${SIGNAL_CHANNEL_ID}:${normalized}`,
  });
}
