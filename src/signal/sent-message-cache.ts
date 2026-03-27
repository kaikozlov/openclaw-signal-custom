import { normalizeE164 } from "../runtime-api.js";
import { looksLikeUuid } from "./identity.js";

const PHONE_RE = /^\+?[0-9][0-9\s().-]*$/;
const MAX_ENTRIES = 5_000;
const TTL_MS = 24 * 60 * 60 * 1000;

type SentSignalMessageCacheEntry = {
  conversationKey: string;
  messageId: string;
  recordedAt: number;
};

const sentMessageByConversation = new Map<string, SentSignalMessageCacheEntry>();

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
  const trimmed = raw
    ?.trim()
    ?.replace(/^signal-custom:/i, "")
    .replace(/^signal:/i, "")
    .trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    const uuid = trimmed.slice("uuid:".length).trim();
    return looksLikeUuid(uuid) ? `direct:uuid:${uuid.toLowerCase()}` : undefined;
  }
  if (looksLikeUuid(trimmed)) {
    return `direct:uuid:${trimmed.toLowerCase()}`;
  }
  if (PHONE_RE.test(trimmed)) {
    return `direct:phone:${normalizeE164(trimmed)}`;
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

function makeKey(conversationKey: string, messageId: string): string {
  return `${conversationKey}:${messageId}`;
}

function pruneIfNeeded(): void {
  const now = Date.now();
  for (const [key, value] of sentMessageByConversation.entries()) {
    if (now - value.recordedAt > TTL_MS) {
      sentMessageByConversation.delete(key);
    }
  }
  if (sentMessageByConversation.size <= MAX_ENTRIES) {
    return;
  }
  const overflow = sentMessageByConversation.size - MAX_ENTRIES;
  const sorted = Array.from(sentMessageByConversation.entries()).sort(
    (
      a: [string, SentSignalMessageCacheEntry],
      b: [string, SentSignalMessageCacheEntry],
    ) => a[1].recordedAt - b[1].recordedAt,
  );
  for (let i = 0; i < overflow; i += 1) {
    const key = sorted[i]?.[0];
    if (key) {
      sentMessageByConversation.delete(key);
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

function resolveSendTarget(target: string): { groupId?: string; recipient?: string } {
  const trimmed = target.trim();
  if (!trimmed) {
    return {};
  }
  const normalized = trimmed.replace(/^signal-custom:/i, "").replace(/^signal:/i, "").trim();
  if (normalized.toLowerCase().startsWith("group:")) {
    const groupId = normalized.slice("group:".length).trim();
    return groupId ? { groupId } : {};
  }
  return { recipient: normalized };
}

export function recordSentSignalMessage(params: { target: string; messageId?: string }): void {
  const { groupId, recipient } = resolveSendTarget(params.target);
  const conversationKey = resolveConversationKey({ groupId, recipient });
  const messageId = normalizeMessageId(params.messageId);
  if (!conversationKey || !messageId) {
    return;
  }
  sentMessageByConversation.set(makeKey(conversationKey, messageId), {
    conversationKey,
    messageId,
    recordedAt: Date.now(),
  });
  pruneIfNeeded();
}

export function wasSentSignalMessage(params: {
  groupId?: string;
  recipient?: string;
  messageId?: string;
}): boolean {
  const conversationKey = resolveConversationKey({
    groupId: params.groupId,
    recipient: params.recipient,
  });
  const messageId = normalizeMessageId(params.messageId);
  if (!conversationKey || !messageId) {
    return false;
  }
  const key = makeKey(conversationKey, messageId);
  const hit = sentMessageByConversation.get(key);
  if (!hit) {
    return false;
  }
  if (Date.now() - hit.recordedAt > TTL_MS) {
    sentMessageByConversation.delete(key);
    return false;
  }
  return true;
}

export function __clearSentSignalMessageCacheForTests(): void {
  sentMessageByConversation.clear();
}
