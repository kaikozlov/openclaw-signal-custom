import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
  type RoutePeer,
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "./runtime-api.js";
import { SIGNAL_CHANNEL_ID, stripSignalChannelPrefix } from "./constants.js";

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
