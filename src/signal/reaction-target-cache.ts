import { normalizeE164 } from "openclaw/plugin-sdk";

const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[0-9][0-9\s().-]*$/;
const MAX_ENTRIES = 5_000;
const TTL_MS = 24 * 60 * 60 * 1000;

type SignalReactionTargetCacheEntry = {
  conversationKey: string;
  messageId: string;
  targetAuthorUuid?: string;
  targetAuthor?: string;
  recordedAt: number;
};

const reactionTargetByMessage = new Map<string, SignalReactionTargetCacheEntry>();

function normalizeGroupId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return (
    trimmed
      .replace(/^signal-custom:/i, "")
      .replace(/^signal:/i, "")
      .replace(/^group:/i, "")
      .trim() || undefined
  );
}

function normalizeDirectRecipient(raw?: string): string | undefined {
  const uuid = normalizeUuid(raw);
  if (uuid) {
    return `direct:uuid:${uuid}`;
  }
  const phone = normalizePhone(raw);
  if (phone) {
    return `direct:phone:${phone}`;
  }
  const trimmed = raw
    ?.trim()
    ?.replace(/^signal-custom:/i, "")
    .replace(/^signal:/i, "")
    .trim();
  if (!trimmed) {
    return undefined;
  }
  return `direct:raw:${trimmed.toLowerCase()}`;
}

function normalizeMessageId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeUuid(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed
    .replace(/^signal-custom:/i, "")
    .replace(/^signal:/i, "")
    .replace(/^uuid:/i, "")
    .trim();
  return SIGNAL_UUID_RE.test(stripped) ? stripped : undefined;
}

function normalizePhone(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed.replace(/^signal-custom:/i, "").replace(/^signal:/i, "").trim();
  if (!PHONE_RE.test(stripped)) {
    return undefined;
  }
  return normalizeE164(stripped);
}

function makeKey(groupId: string, messageId: string): string {
  return `${groupId}:${messageId}`;
}

function pruneIfNeeded(): void {
  const now = Date.now();
  for (const [key, value] of reactionTargetByMessage.entries()) {
    if (now - value.recordedAt > TTL_MS) {
      reactionTargetByMessage.delete(key);
    }
  }
  if (reactionTargetByMessage.size <= MAX_ENTRIES) {
    return;
  }
  const overflow = reactionTargetByMessage.size - MAX_ENTRIES;
  const sorted = Array.from(reactionTargetByMessage.entries()).sort(
    (
      a: [string, SignalReactionTargetCacheEntry],
      b: [string, SignalReactionTargetCacheEntry],
    ) => a[1].recordedAt - b[1].recordedAt,
  );
  for (let i = 0; i < overflow; i += 1) {
    const key = sorted[i]?.[0];
    if (key) {
      reactionTargetByMessage.delete(key);
    }
  }
}

function resolveConversationKey(params: {
  groupId?: string;
  recipient?: string;
}): string | undefined {
  const groupId = normalizeGroupId(params.groupId);
  if (groupId) {
    return `group:${groupId}`;
  }
  return normalizeDirectRecipient(params.recipient);
}

export function recordSignalReactionTarget(params: {
  groupId?: string;
  recipient?: string;
  messageId?: string;
  senderId?: string;
  senderE164?: string;
}): void {
  const conversationKey = resolveConversationKey({
    groupId: params.groupId,
    recipient: params.recipient,
  });
  const messageId = normalizeMessageId(params.messageId);
  if (!conversationKey || !messageId) {
    return;
  }
  const targetAuthorUuid = normalizeUuid(params.senderId);
  const targetAuthor = normalizePhone(params.senderE164) ?? normalizePhone(params.senderId);
  if (!targetAuthorUuid && !targetAuthor) {
    return;
  }
  reactionTargetByMessage.set(makeKey(conversationKey, messageId), {
    conversationKey,
    messageId,
    targetAuthorUuid,
    targetAuthor,
    recordedAt: Date.now(),
  });
  pruneIfNeeded();
}

export function resolveSignalReactionTarget(params: {
  groupId?: string;
  recipient?: string;
  messageId?: string;
}): { targetAuthorUuid?: string; targetAuthor?: string } | undefined {
  const conversationKey = resolveConversationKey({
    groupId: params.groupId,
    recipient: params.recipient,
  });
  const messageId = normalizeMessageId(params.messageId);
  if (!conversationKey || !messageId) {
    return undefined;
  }
  const key = makeKey(conversationKey, messageId);
  const hit = reactionTargetByMessage.get(key);
  if (!hit) {
    return undefined;
  }
  if (Date.now() - hit.recordedAt > TTL_MS) {
    reactionTargetByMessage.delete(key);
    return undefined;
  }
  return {
    targetAuthorUuid: hit.targetAuthorUuid,
    targetAuthor: hit.targetAuthor,
  };
}

export function __clearSignalReactionTargetCacheForTests(): void {
  reactionTargetByMessage.clear();
}
