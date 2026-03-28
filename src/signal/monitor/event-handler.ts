import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createChannelReplyPipeline,
  createStatusReactionController,
  DM_GROUP_ACCESS_REASON,
  formatInboundFromLabel,
  logInboundDrop,
  logTypingFailure,
  normalizeE164,
  recordPendingHistoryEntryIfEnabled,
  resolveAckReaction,
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
  resolveSendableOutboundReplyParts,
  shouldAckReaction,
  type ReplyPayload,
} from "../../runtime-api.js";
import { SIGNAL_CHANNEL_ID } from "../../constants.js";
import { getSignalRuntime } from "../../runtime.js";
import { normalizeSignalCustomMessagingTarget } from "../../targets.js";
import { createChannelInboundDebouncer } from "../inbound-debounce.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
  type SignalSender,
} from "../identity.js";
import { resolveSignalAccount, resolveSignalMarkdownTableMode } from "../../config.js";
import { recordSignalReactionTarget } from "../reaction-target-cache.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { removeReactionSignal, sendReactionSignal } from "../send-reactions.js";
import { editMessageSignal } from "../send-actions.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalAttachment,
  SignalDataMessage,
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalMention,
  SignalReactionMessage,
  SignalReceivePayload,
  SignalStoryMessage,
  SignalTextStyleRange,
} from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";
import { resolveSignalGroupRuntimeConfig } from "../group-config.js";
import { createRecentSignalInboundDeduper } from "../recent-inbound-dedupe.js";
import {
  markdownToSignalRichChunks,
  type SignalTextStyleRange as FormattedSignalTextStyleRange,
} from "../format.js";
import { createSignalDraftStream } from "../draft-stream.js";

const MAX_SIGNAL_INBOUND_ATTACHMENT_FETCH_CONCURRENCY = 4;

function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {
    return null;
  }
  const normalizedOwners = Array.from(
    new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}

function hasMentionTargetMetadata(mentions: SignalMention[] | null | undefined): boolean {
  return Boolean(
    mentions?.some((mention) => {
      const uuid = typeof mention?.uuid === "string" ? mention.uuid.trim() : "";
      const number = typeof mention?.number === "string" ? mention.number.trim() : "";
      return Boolean(uuid || number);
    }),
  );
}

function isMentionedBySignalMetadata(params: {
  mentions: SignalMention[] | null | undefined;
  account?: string;
  accountUuid?: string;
}): boolean {
  const accountNumber = params.account?.trim();
  const accountUuid = params.accountUuid?.trim().toLowerCase();
  const normalizedAccountE164 = accountNumber ? normalizeE164(accountNumber) : "";
  return Boolean(
    params.mentions?.some((mention) => {
      const mentionNumberRaw = typeof mention?.number === "string" ? mention.number.trim() : "";
      if (mentionNumberRaw && normalizedAccountE164) {
        if (normalizeE164(mentionNumberRaw) === normalizedAccountE164) {
          return true;
        }
      }
      const mentionUuid = typeof mention?.uuid === "string" ? mention.uuid.trim().toLowerCase() : "";
      return Boolean(accountUuid && mentionUuid && mentionUuid === accountUuid);
    }),
  );
}

function normalizeDimensionValue(value?: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function normalizeCaptionValue(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeSenderNameValue(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shouldBufferSignalTerminalPayload(
  payload: ReplyPayload,
  kind: "final" | "block" | "tool",
): boolean {
  if (kind === "tool") {
    return false;
  }
  if (payload.isReasoning === true || payload.isCompactionNotice === true) {
    return false;
  }
  return resolveSendableOutboundReplyParts(payload).hasContent;
}

async function settleWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) {
    return [];
  }
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  const concurrency = Math.max(1, Math.min(items.length, Math.trunc(limit)));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await worker(items[currentIndex]!, currentIndex),
          };
        } catch (reason) {
          results[currentIndex] = {
            status: "rejected",
            reason,
          };
        }
      }
    }),
  );

  return results;
}

function resolveSignalDraftFinalChunk(params: {
  payload: ReplyPayload;
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: string;
  textLimit: number;
}):
  | {
      text: string;
      styles: FormattedSignalTextStyleRange[];
      mentions?: Array<{ start: number; length: number; recipient: string }>;
    }
  | undefined {
  if (params.payload.isError) {
    return undefined;
  }
  const text = typeof params.payload.text === "string" ? params.payload.text : "";
  if (!text.trim()) {
    return undefined;
  }
  if (typeof params.payload.replyToId === "string" && params.payload.replyToId.trim()) {
    return undefined;
  }
  const parts = resolveSendableOutboundReplyParts(params.payload, { text });
  if (parts.hasMedia) {
    return undefined;
  }
  if (isRecord(params.payload.channelData)) {
    const signalData = params.payload.channelData[SIGNAL_CHANNEL_ID] ?? params.payload.channelData.signal;
    if (isRecord(signalData) && Object.keys(signalData).length > 0) {
      return undefined;
    }
  }
  const chunks = markdownToSignalRichChunks(text, params.textLimit, {
    tableMode: resolveSignalMarkdownTableMode({
      cfg: params.cfg,
      accountId: params.accountId,
    }),
  });
  if (chunks.length !== 1) {
    return undefined;
  }
  const chunk = chunks[0];
  if (!chunk?.text.trim()) {
    return undefined;
  }
  return chunk;
}

function resolveSignalMediaKind(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const normalized = mime.trim().toLowerCase().split(";")[0]?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized === "application/pdf" || normalized.startsWith("text/")) {
    return "document";
  }
  if (normalized.startsWith("application/")) {
    return "document";
  }
  return "unknown";
}

const SIGNAL_MARKDOWN_STYLE_MARKERS: Record<string, { open: string; close: string }> = {
  BOLD: { open: "**", close: "**" },
  ITALIC: { open: "_", close: "_" },
  MONOSPACE: { open: "`", close: "`" },
  STRIKETHROUGH: { open: "~~", close: "~~" },
  SPOILER: { open: "||", close: "||" },
};

function applySignalTextStyles(text: string, styles?: SignalTextStyleRange[] | null): string {
  if (!text || !Array.isArray(styles) || styles.length === 0) {
    return text;
  }

  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();
  const normalizedRanges = styles
    .map((style) => {
      const marker = style.style ? SIGNAL_MARKDOWN_STYLE_MARKERS[style.style] : undefined;
      if (!marker) {
        return null;
      }
      if (typeof style.start !== "number" || typeof style.length !== "number") {
        return null;
      }
      if (!Number.isFinite(style.start) || !Number.isFinite(style.length)) {
        return null;
      }
      const start = Math.max(0, Math.trunc(style.start));
      const length = Math.max(0, Math.trunc(style.length));
      if (length <= 0 || start >= text.length) {
        return null;
      }
      const end = Math.min(text.length, start + length);
      if (end <= start) {
        return null;
      }
      return { start, end, marker };
    })
    .filter(
      (
        range,
      ): range is { start: number; end: number; marker: { open: string; close: string } } =>
        Boolean(range),
    )
    .sort((a, b) => {
      if (a.start !== b.start) {
        return b.start - a.start;
      }
      return b.end - a.end;
    });

  for (const range of normalizedRanges) {
    const openList = opens.get(range.start) ?? [];
    openList.push(range.marker.open);
    opens.set(range.start, openList);

    const closeList = closes.get(range.end) ?? [];
    closeList.push(range.marker.close);
    closes.set(range.end, closeList);
  }

  let output = text;
  for (let index = text.length; index >= 0; index -= 1) {
    const closeList = closes.get(index);
    const openList = opens.get(index);
    if (!closeList && !openList) {
      continue;
    }
    const insertion = `${(closeList ?? []).join("")}${(openList ?? []).join("")}`;
    output = `${output.slice(0, index)}${insertion}${output.slice(index)}`;
  }

  return output;
}

function buildSignalLinkPreviewContext(
  previews?: Array<{
    url?: string | null;
    title?: string | null;
    description?: string | null;
  }> | null,
): string[] {
  if (!Array.isArray(previews) || previews.length === 0) {
    return [];
  }

  const context: string[] = [];
  for (const preview of previews) {
    const url = preview.url?.trim();
    if (!url) {
      continue;
    }
    const title = preview.title?.trim();
    const description = preview.description?.trim();
    const label = title && description ? `${title} - ${description}` : title || description || url;
    context.push(`Link preview: ${label} (${url})`);
  }
  return context;
}

function buildSignalContactContext(
  contacts?: Array<{
    name?: { display?: string | null; given?: string | null; family?: string | null } | null;
    phone?: Array<{ value?: string | null; type?: string | null }> | null;
    email?: Array<{ value?: string | null; type?: string | null }> | null;
    organization?: string | null;
  }> | null,
): string[] {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return [];
  }

  const context: string[] = [];
  for (const contact of contacts) {
    const displayName =
      contact.name?.display?.trim() ||
      `${contact.name?.given?.trim() ?? ""} ${contact.name?.family?.trim() ?? ""}`.trim() ||
      "Unknown";
    const phone = contact.phone?.[0]?.value?.trim();
    const email = contact.email?.[0]?.value?.trim();
    const organization = contact.organization?.trim();
    const details = [phone, email, organization].filter(Boolean).join(", ");
    if (!details && displayName === "Unknown") {
      continue;
    }
    context.push(`Shared contact: ${details ? `${displayName} (${details})` : displayName}`);
  }
  return context;
}

function normalizeSignalPollOption(
  option: string | { text?: string | null } | null | undefined,
): string | undefined {
  if (typeof option === "string") {
    const trimmed = option.trim();
    return trimmed || undefined;
  }
  const trimmed = option?.text?.trim();
  return trimmed || undefined;
}

function buildSignalPollContext(params: {
  pollCreate?: {
    question?: string | null;
    allowMultiple?: boolean | null;
    options?: Array<string | { text?: string | null } | null> | null;
  } | null;
  pollVote?: {
    targetSentTimestamp?: number | null;
    optionIndexes?: number[] | null;
  } | null;
  pollTerminate?: { targetSentTimestamp?: number | null } | null;
}): string[] {
  const context: string[] = [];

  if (params.pollCreate) {
    const question = params.pollCreate.question?.trim() || "Untitled";
    const options =
      params.pollCreate.options?.map((option) => normalizeSignalPollOption(option)).filter(Boolean) ?? [];
    if (options.length > 0) {
      const suffix = params.pollCreate.allowMultiple === true ? " (multiple selections allowed)" : "";
      context.push(`Poll: "${question}" — Options: ${options.join(", ")}${suffix}`);
    } else {
      context.push(`Poll: "${question}"`);
    }
  }

  if (params.pollVote?.targetSentTimestamp != null) {
    const indexes =
      params.pollVote.optionIndexes?.filter((index) => typeof index === "number" && Number.isFinite(index)) ??
      [];
    context.push(
      `Poll vote on #${params.pollVote.targetSentTimestamp}: option(s) ${
        indexes.length > 0 ? indexes.join(", ") : "unknown"
      }`,
    );
  }

  if (params.pollTerminate?.targetSentTimestamp != null) {
    context.push(`Poll #${params.pollTerminate.targetSentTimestamp} closed`);
  }

  return context;
}

function buildSignalAttachmentDetailContext(params: {
  captions?: string[];
  dimensions?: Array<{ width?: number; height?: number }>;
}): string[] {
  const max = Math.max(params.captions?.length ?? 0, params.dimensions?.length ?? 0);
  if (max === 0) {
    return [];
  }
  const context: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const details: string[] = [];
    const dimension = params.dimensions?.[index];
    if (dimension?.width && dimension?.height) {
      details.push(`${dimension.width}x${dimension.height}`);
    } else if (dimension?.width) {
      details.push(`width=${dimension.width}`);
    } else if (dimension?.height) {
      details.push(`height=${dimension.height}`);
    }
    const caption = params.captions?.[index]?.trim();
    if (caption) {
      details.push(JSON.stringify(caption));
    }
    if (details.length > 0) {
      context.push(`Signal attachment ${index + 1}: ${details.join(", ")}`);
    }
  }
  return context;
}

function normalizeStoryTimestamp(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function normalizeSignalStoryAuthor(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function buildSignalStoryContext(params: {
  author?: string;
  timestamp?: number;
  allowsReplies?: boolean;
}): string[] {
  const context: string[] = [];
  if (typeof params.allowsReplies === "boolean") {
    context.push(`Signal story replies: ${params.allowsReplies ? "enabled" : "disabled"}`);
  }
  if (params.author || params.timestamp) {
    const details = [
      params.author ? `author ${params.author}` : undefined,
      typeof params.timestamp === "number" ? `timestamp ${params.timestamp}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    if (details) {
      context.push(`Signal story context: ${details}`);
    }
  }
  return context;
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    commandBody: string;
    bodyTextPlain: string;
    timestamp?: number;
    messageId?: string;
    editTargetTimestamp?: number;
    isEdit?: boolean;
    mediaPath?: string;
    mediaType?: string;
    mediaCaption?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    mediaCaptions?: string[];
    mediaDimension?: { width?: number; height?: number };
    mediaDimensions?: Array<{ width?: number; height?: number }>;
    untrustedContext?: string[];
    commandAuthorized: boolean;
    wasMentioned?: boolean;
    shouldAckReaction?: boolean;
    ackTargetTimestamp?: number;
    statusReactionTargetAuthor?: string;
    statusReactionTargetAuthorUuid?: string;
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    replyToIsStory?: boolean;
    storyReplyTimestamp?: number;
    storyReplyAuthor?: string;
    receivedAtMs: number;
    preprocessMs?: number;
    attachmentResolveMs?: number;
    mergedEntryCount?: number;
  };

  const pluginRuntime = getSignalRuntime();
  const typingTtlMs = resolveSignalAccount({
    cfg: deps.cfg,
    accountId: deps.accountId,
  }).config.typingTtlMs;
  const logVerbose = (message: string) => {
    if (pluginRuntime.logging.shouldLogVerbose()) {
      deps.runtime.log?.(message);
    }
  };
  const recentInboundDeduper = createRecentSignalInboundDeduper();

  function logInboundTiming(params: {
    entry: SignalInboundEntry;
    contextBuildMs: number;
    dispatchMs: number;
  }) {
    if (!pluginRuntime.logging.shouldLogVerbose()) {
      return;
    }
    const totalMs = Math.max(0, Date.now() - params.entry.receivedAtMs);
    logVerbose(
      `signal inbound timing: entries=${Math.max(1, params.entry.mergedEntryCount ?? 1)} preprocess_ms=${Math.max(0, params.entry.preprocessMs ?? 0)} attachments_ms=${Math.max(0, params.entry.attachmentResolveMs ?? 0)} context_ms=${params.contextBuildMs} dispatch_ms=${params.dispatchMs} total_ms=${totalMs}`,
    );
  }

  function buildSignalInboundDedupeKey(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    dataMessage?: SignalDataMessage | null;
    groupId?: string;
    reaction?: SignalReactionMessage | null;
    isEditMessage?: boolean;
    editTargetTimestamp?: number;
  }): string | null {
    const eventTimestamp =
      resolveSignalEventTimestamp(params.dataMessage?.timestamp) ??
      resolveSignalEventTimestamp(params.envelope.timestamp) ??
      resolveSignalEventTimestamp(params.reaction?.targetSentTimestamp) ??
      params.editTargetTimestamp ??
      null;
    if (!eventTimestamp) {
      return null;
    }
    const senderKey =
      params.sender.kind === "phone" ? params.sender.e164 : `uuid:${params.sender.raw}`;
    const scope = params.groupId ? `group:${params.groupId}` : "direct";
    const kind = params.reaction
      ? `reaction:${params.reaction.emoji ?? ""}:${params.reaction.isRemove === true || params.reaction.remove === true ? "remove" : "add"}`
      : params.isEditMessage
        ? `edit:${params.editTargetTimestamp ?? eventTimestamp}`
        : "message";
    return `${scope}|${senderKey}|${eventTimestamp}|${kind}`;
  }

  function enqueueSignalSystemEvent(params: {
    text: string;
    sessionKey: string;
    contextKey: string;
    wakeAgent?: boolean;
  }) {
    pluginRuntime.system.enqueueSystemEvent(params.text, {
      sessionKey: params.sessionKey,
      contextKey: params.contextKey,
    });
    if (!params.wakeAgent) {
      return;
    }
    pluginRuntime.system.requestHeartbeatNow({
      sessionKey: params.sessionKey,
      coalesceMs: 500,
    });
  }

  async function fetchInboundMediaBundle(params: {
    attachments: SignalAttachment[];
    senderRecipient: string;
    groupId?: string;
  }): Promise<{
    mediaPath?: string;
    mediaType?: string;
    mediaCaption?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    mediaCaptions?: string[];
    mediaDimension?: { width?: number; height?: number };
    mediaDimensions?: Array<{ width?: number; height?: number }>;
  }> {
    if (deps.ignoreAttachments || params.attachments.length === 0) {
      return {};
    }

    const fetchedMedia: Array<{
      path: string;
      contentType?: string;
      caption?: string;
      width?: number;
      height?: number;
    }> = [];
    const fetchResults = await settleWithConcurrencyLimit(
      params.attachments,
      MAX_SIGNAL_INBOUND_ATTACHMENT_FETCH_CONCURRENCY,
      async (attachment) => {
        if (!attachment?.id) {
          return null;
        }
        const fetched = await deps.fetchAttachment({
          baseUrl: deps.baseUrl,
          account: deps.account,
          attachment,
          sender: params.senderRecipient,
          groupId: params.groupId,
          maxBytes: deps.mediaMaxBytes,
        });
        if (!fetched) {
          return null;
        }
        return {
          path: fetched.path,
          contentType: fetched.contentType ?? attachment.contentType ?? undefined,
          caption: normalizeCaptionValue(attachment.caption),
          width: normalizeDimensionValue(attachment.width),
          height: normalizeDimensionValue(attachment.height),
        };
      },
    );
    for (const result of fetchResults) {
      if (result.status === "rejected") {
        deps.runtime.error?.(`attachment fetch failed: ${String(result.reason)}`);
        continue;
      }
      if (result.value) {
        fetchedMedia.push(result.value);
      }
    }
    if (fetchedMedia.length === 0) {
      return {};
    }

    const mediaCaptions = fetchedMedia.map((entry) => entry.caption ?? "");
    const fetchedDimensions = fetchedMedia.map((entry) => ({
      width: entry.width,
      height: entry.height,
    }));
    const hasDimensions = fetchedDimensions.some((entry) => entry.width || entry.height);
    return {
      mediaPath: fetchedMedia[0]?.path,
      mediaType: fetchedMedia[0]?.contentType ?? params.attachments[0]?.contentType ?? undefined,
      mediaCaption: fetchedMedia[0]?.caption,
      mediaPaths: fetchedMedia.map((entry) => entry.path),
      mediaTypes: fetchedMedia.map((entry) => entry.contentType ?? "application/octet-stream"),
      mediaCaptions: mediaCaptions.some((entry) => entry.trim().length > 0) ? mediaCaptions : undefined,
      mediaDimension: hasDimensions ? fetchedDimensions[0] : undefined,
      mediaDimensions: hasDimensions ? fetchedDimensions : undefined,
    };
  }

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const contextStartedAt = Date.now();
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: deps.cfg,
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
      peer: {
        kind: entry.isGroup ? "group" : "direct",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId,
      },
    });
    const storePath = pluginRuntime.channel.session.resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = pluginRuntime.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = pluginRuntime.channel.reply.formatInboundEnvelope({
      channel: "Signal Custom",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          pluginRuntime.channel.reply.formatInboundEnvelope({
            channel: "Signal Custom",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const hasInboundMedia =
      Boolean(entry.mediaPath || entry.mediaType || entry.mediaCaption) ||
      Boolean(Array.isArray(entry.mediaPaths) && entry.mediaPaths.length > 0) ||
      Boolean(Array.isArray(entry.mediaTypes) && entry.mediaTypes.length > 0) ||
      Boolean(Array.isArray(entry.mediaCaptions) && entry.mediaCaptions.length > 0);
    const bodyForReply = hasInboundMedia ? entry.bodyText : combinedBody;
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `${SIGNAL_CHANNEL_ID}:${entry.senderRecipient}`;
    const signalTo = normalizeSignalCustomMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
            sender: historyEntry.sender,
            body: historyEntry.body,
            timestamp: historyEntry.timestamp,
          }))
        : undefined;
    const signalGroupRuntime = entry.isGroup
      ? resolveSignalGroupRuntimeConfig({
          cfg: deps.cfg,
          groupId: entry.groupId,
          accountId: deps.accountId,
        })
      : undefined;
    const skillFilter = signalGroupRuntime?.skills;
    const groupSystemPrompt = signalGroupRuntime?.systemPrompt?.trim() || undefined;
    const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
      Body: bodyForReply,
      BodyForAgent: entry.bodyText,
      InboundHistory: inboundHistory,
      RawBody: entry.bodyText,
      CommandBody: entry.commandBody,
      BodyForCommands: entry.commandBody,
      From: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `${SIGNAL_CHANNEL_ID}:${entry.senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      GroupSystemPrompt: entry.isGroup ? groupSystemPrompt : undefined,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: SIGNAL_CHANNEL_ID,
      Surface: SIGNAL_CHANNEL_ID,
      MessageSid: entry.messageId,
      EditTargetTimestamp: entry.editTargetTimestamp,
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaCaption: entry.mediaCaption,
      MediaUrl: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      MediaCaptions: entry.mediaCaptions,
      MediaDimension: entry.mediaDimension,
      MediaDimensions: entry.mediaDimensions,
      MediaUrls: entry.mediaPaths,
      UntrustedContext: entry.untrustedContext,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: SIGNAL_CHANNEL_ID,
      OriginatingTo: signalTo,
      ReplyToId: entry.replyToId,
      ReplyToBody: entry.replyToBody,
      ReplyToSender: entry.replyToSender,
      ReplyToIsQuote: entry.replyToIsQuote === true ? true : undefined,
      ReplyToIsStory: entry.replyToIsStory === true ? true : undefined,
      StoryReplyTimestamp: entry.storyReplyTimestamp,
      StoryReplyAuthor: entry.storyReplyAuthor,
    });

    await pluginRuntime.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup && route.sessionKey === route.mainSessionKey
        ? {
            sessionKey: route.mainSessionKey,
            channel: SIGNAL_CHANNEL_ID,
            to: entry.senderRecipient,
            accountId: route.accountId,
            mainDmOwnerPin: (() => {
              const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
                dmScope: deps.cfg.session?.dmScope,
                allowFrom: deps.allowFrom,
                normalizeEntry: normalizeSignalAllowRecipient,
              });
              if (!pinnedOwner) {
                return undefined;
              }
              return {
                ownerRecipient: pinnedOwner,
                senderRecipient: entry.senderRecipient,
                onSkip: ({ ownerRecipient, senderRecipient }) => {
                  logVerbose(
                    `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                  );
                },
              };
            })(),
          }
        : undefined,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      },
    });

    if (pluginRuntime.logging.shouldLogVerbose()) {
      const preview = bodyForReply.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `signal inbound: from=${ctxPayload.From} len=${bodyForReply.length} preview="${preview}"`,
      );
    }

    const reactionLevel =
      resolveSignalAccount({
        cfg: deps.cfg,
        accountId: deps.accountId,
      }).config.reactionLevel ?? "minimal";
    const ackEmoji = resolveAckReaction(deps.cfg, route.agentId, {
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
    }).trim();
    const statusReactionsConfig = deps.cfg.messages?.statusReactions;
    const ackReactionsEnabled = reactionLevel === "ack";
    const agentReactionsEnabled = reactionLevel === "minimal" || reactionLevel === "extensive";
    const statusReactionController =
      entry.shouldAckReaction &&
      typeof entry.ackTargetTimestamp === "number" &&
      Boolean(ackEmoji) &&
      statusReactionsConfig?.enabled === true &&
      agentReactionsEnabled
        ? createStatusReactionController({
            enabled: true,
            adapter: {
              setReaction: async (emoji: string) => {
                await sendReactionSignal(entry.senderRecipient, entry.ackTargetTimestamp!, emoji, {
                  cfg: deps.cfg,
                  accountId: deps.accountId,
                  groupId: entry.groupId,
                  targetAuthor: entry.statusReactionTargetAuthor,
                  targetAuthorUuid: entry.statusReactionTargetAuthorUuid,
                });
              },
              removeReaction: async (emoji: string) => {
                await removeReactionSignal(entry.senderRecipient, entry.ackTargetTimestamp!, emoji, {
                  cfg: deps.cfg,
                  accountId: deps.accountId,
                  groupId: entry.groupId,
                  targetAuthor: entry.statusReactionTargetAuthor,
                  targetAuthorUuid: entry.statusReactionTargetAuthorUuid,
                });
              },
            },
            initialEmoji: ackEmoji,
            emojis: statusReactionsConfig.emojis,
            timing: statusReactionsConfig.timing,
            onError: (err) => {
              logVerbose(`Signal status reaction failed: ${String(err)}`);
            },
          })
        : null;
    if (entry.shouldAckReaction && typeof entry.ackTargetTimestamp === "number") {
      if (statusReactionController) {
        void Promise.resolve(statusReactionController.setQueued()).catch((err) => {
          logVerbose(`Signal status reaction failed: ${String(err)}`);
        });
      } else if (ackReactionsEnabled) {
        void sendReactionSignal(entry.senderRecipient, entry.ackTargetTimestamp, ackEmoji, {
          cfg: deps.cfg,
          accountId: deps.accountId,
          groupId: entry.groupId,
          targetAuthor: entry.statusReactionTargetAuthor,
          targetAuthorUuid: entry.statusReactionTargetAuthorUuid,
        }).catch((err) => {
          logVerbose(`Signal ack reaction failed: ${String(err)}`);
        });
      }
    }

    const resolvedStreamMode =
      deps.streamMode ??
      (typeof deps.blockStreaming === "boolean" ? (deps.blockStreaming ? "block" : "off") : "block");
    const silentIntermediateReplies = deps.silentIntermediateReplies !== false;
    const intermediateReplySilent = silentIntermediateReplies ? true : undefined;
    const draftStream =
      resolvedStreamMode === "draft" && ctxPayload.To
        ? createSignalDraftStream({
            cfg: deps.cfg,
            to: ctxPayload.To,
            accountId: deps.accountId,
            replyToId: entry.messageId,
            maxChars: Math.min(deps.textLimit, 4000),
            throttleMs: 1200,
            minInitialChars: 30,
            log: logVerbose,
            warn: logVerbose,
          })
        : undefined;
    let finalizedViaDraftPreview = false;
    let pendingTerminalBlock: ReplyPayload | undefined;

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: SIGNAL_CHANNEL_ID,
      accountId: route.accountId,
      typing: {
        start: async () => {
          if (!ctxPayload.To) {
            return;
          }
          await sendTypingSignal(ctxPayload.To, {
            cfg: deps.cfg,
            accountId: deps.accountId,
          });
        },
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: SIGNAL_CHANNEL_ID,
            target: ctxPayload.To ?? undefined,
            error: err,
          });
        },
        stop: async () => {
          if (!ctxPayload.To) {
            return;
          }
          await sendTypingSignal(ctxPayload.To, {
            cfg: deps.cfg,
            accountId: deps.accountId,
            stop: true,
          });
        },
        onStopError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: SIGNAL_CHANNEL_ID,
            target: ctxPayload.To ?? undefined,
            error: err,
          });
        },
        ...(typeof typingTtlMs === "number" ? { maxDurationMs: typingTtlMs } : {}),
      },
    });

    const dispatchStartedAt = Date.now();
    const contextBuildMs = Math.max(0, dispatchStartedAt - contextStartedAt);
    const deliverSignalReply = async (payload: ReplyPayload, silent?: boolean) => {
      await deps.deliverReplies({
        replies: [payload],
        target: ctxPayload.To,
        baseUrl: deps.baseUrl,
        account: deps.account,
        accountId: deps.accountId,
        runtime: deps.runtime,
        maxBytes: deps.mediaMaxBytes,
        textLimit: deps.textLimit,
        silent,
        quoteAuthor: entry.senderRecipient || undefined,
        storyTimestamp: entry.storyReplyTimestamp,
        storyAuthor: entry.storyReplyAuthor,
      });
    };
    const flushPendingTerminalBlock = async (silent?: boolean): Promise<boolean> => {
      const payload = pendingTerminalBlock;
      if (!payload) {
        return false;
      }
      pendingTerminalBlock = undefined;
      await deliverSignalReply(payload, silent);
      return shouldBufferSignalTerminalPayload(payload, "final");
    };

    const { queuedFinal } =
      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: deps.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          humanDelay: pluginRuntime.channel.reply.resolveHumanDelayConfig(deps.cfg, route.agentId),
          deliver: async (payload, info) => {
            // OpenClaw partial replies are handled separately via replyOptions.onPartialReply.
            // This callback only sees dispatched tool/block/final payloads.
            const kind = info?.kind ?? "final";
            if (
              resolvedStreamMode === "block" &&
              shouldBufferSignalTerminalPayload(payload, kind)
            ) {
              await flushPendingTerminalBlock(intermediateReplySilent);
              pendingTerminalBlock = payload;
              return;
            }
            await flushPendingTerminalBlock(intermediateReplySilent);
            if (draftStream && kind === "final") {
              await draftStream.flush();
              const previewMessageId = draftStream.messageId();
              const finalChunk =
                typeof previewMessageId === "string"
                  ? resolveSignalDraftFinalChunk({
                      payload,
                      cfg: deps.cfg,
                      accountId: deps.accountId,
                      textLimit: deps.textLimit,
                    })
                  : undefined;
              if (previewMessageId && finalChunk) {
                try {
                  await editMessageSignal({
                    cfg: deps.cfg,
                    to: ctxPayload.To,
                    text: finalChunk.text,
                    textMode: "plain",
                    textStyles: finalChunk.styles,
                    mentions: finalChunk.mentions,
                    editTimestamp: Number(previewMessageId),
                    opts: { accountId: deps.accountId },
                  });
                  finalizedViaDraftPreview = true;
                  return;
                } catch (err) {
                  logVerbose(`signal draft preview final edit failed, falling back: ${String(err)}`);
                }
              }
              await draftStream.clear();
            }
            await deliverSignalReply(
              payload,
              silentIntermediateReplies &&
              (kind !== "final" ||
                payload.isReasoning === true ||
                payload.isCompactionNotice === true)
                ? true
                : undefined,
            );
          },
          onError: (err, info) => {
            deps.runtime.error?.(`signal ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyOptions: {
          skillFilter,
          disableBlockStreaming:
            draftStream ? true : resolvedStreamMode === "off" ? true : undefined,
          onModelSelected,
          onPartialReply:
            draftStream || statusReactionController
              ? async (payload: { text?: string }) => {
                  if (draftStream && payload.text) {
                    draftStream.update(payload.text);
                  }
                  if (!statusReactionController) {
                    return;
                  }
                  await Promise.resolve(statusReactionController.setThinking());
                }
              : undefined,
          onToolStart: statusReactionController
            ? async ({ name }: { name?: string }) => {
                await Promise.resolve(statusReactionController.setTool(name));
              }
            : undefined,
          onCompactionStart: statusReactionController
            ? async () => {
                await Promise.resolve(statusReactionController.setCompacting());
              }
            : undefined,
          onCompactionEnd: statusReactionController
            ? async () => {
                statusReactionController.cancelPending();
                await Promise.resolve(statusReactionController.setThinking());
              }
            : undefined,
        },
      });
    const terminalBlockDelivered = await flushPendingTerminalBlock();
    const deliveredFinalReply = queuedFinal || terminalBlockDelivered;
    const dispatchMs = Math.max(0, Date.now() - dispatchStartedAt);

    if (draftStream) {
      try {
        await draftStream.stop();
        if (!finalizedViaDraftPreview) {
          await draftStream.clear();
        }
      } catch (err) {
        logVerbose(`signal draft preview cleanup failed: ${String(err)}`);
      }
    }

    if (statusReactionController) {
      if (!deliveredFinalReply) {
        void statusReactionController.setError().catch((err) => {
          logVerbose(`Signal status reaction failed: ${String(err)}`);
        });
      } else {
        void statusReactionController.setDone().catch((err) => {
          logVerbose(`Signal status reaction failed: ${String(err)}`);
        });
      }
    }

    if (!deliveredFinalReply) {
      logInboundTiming({
        entry,
        contextBuildMs,
        dispatchMs,
      });
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: deps.groupHistories,
          historyKey,
          limit: deps.historyLimit,
        });
      }
      return;
    }
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
      });
    }
    logInboundTiming({
      entry,
      contextBuildMs,
      dispatchMs,
    });
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: SIGNAL_CHANNEL_ID,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `${SIGNAL_CHANNEL_ID}:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.bodyText.trim()) {
        return false;
      }
      if (entry.isEdit) {
        return false;
      }
      if (
        entry.mediaPath ||
        entry.mediaType ||
        entry.mediaCaption ||
        (Array.isArray(entry.mediaPaths) && entry.mediaPaths.length > 0) ||
        (Array.isArray(entry.mediaTypes) && entry.mediaTypes.length > 0) ||
        (Array.isArray(entry.mediaCaptions) && entry.mediaCaptions.length > 0)
      ) {
        return false;
      }
      return !pluginRuntime.channel.text.hasControlCommand(entry.bodyTextPlain, deps.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\n");
      const combinedTextPlain = entries
        .map((entry) => entry.bodyTextPlain)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const mergedUntrustedContext = entries.reduce<string[]>((acc, entry) => {
        if (Array.isArray(entry.untrustedContext)) {
          acc.push(...entry.untrustedContext);
        }
        return acc;
      }, []);
      const combinedCommandBody = entries
        .map((entry) => entry.commandBody)
        .filter(Boolean)
        .join("\n");
      const receivedAtMs = entries.reduce(
        (min, entry) => Math.min(min, entry.receivedAtMs),
        Number.POSITIVE_INFINITY,
      );
      const preprocessMs = entries.reduce((sum, entry) => sum + (entry.preprocessMs ?? 0), 0);
      const attachmentResolveMs = entries.reduce(
        (sum, entry) => sum + (entry.attachmentResolveMs ?? 0),
        0,
      );
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        commandBody: combinedCommandBody || combinedText,
        bodyTextPlain: combinedTextPlain || combinedText,
        mediaPath: undefined,
        mediaType: undefined,
        mediaCaption: undefined,
        mediaPaths: undefined,
        mediaTypes: undefined,
        mediaCaptions: undefined,
        mediaDimension: undefined,
        mediaDimensions: undefined,
        untrustedContext: mergedUntrustedContext.length > 0 ? mergedUntrustedContext : undefined,
        replyToId: undefined,
        replyToBody: undefined,
        replyToSender: undefined,
        replyToIsQuote: undefined,
        editTargetTimestamp: undefined,
        isEdit: undefined,
        receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
        preprocessMs,
        attachmentResolveMs,
        mergedEntryCount: entries.length,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  function isOwnReactionTarget(params: {
    targets: Array<{ kind: "phone" | "uuid"; id: string; display: string }>;
    knownOwnMessage?: boolean;
  }): boolean {
    if (params.knownOwnMessage) {
      return true;
    }
    const normalizedAccount =
      typeof deps.account === "string" ? normalizeSignalAllowRecipient(deps.account) : undefined;
    const normalizedAccountUuid =
      typeof deps.accountUuid === "string" ? deps.accountUuid.trim().toLowerCase() : "";
    return params.targets.some((target) => {
      if (target.kind === "uuid") {
        return Boolean(normalizedAccountUuid && target.id.toLowerCase() === normalizedAccountUuid);
      }
      return Boolean(normalizedAccount && target.id === normalizedAccount);
    });
  }

  async function resolveReactionTargetLabel(params: {
    targets: Array<{ kind: "phone" | "uuid"; id: string; display: string }>;
    knownOwnMessage?: boolean;
  }): Promise<string | undefined> {
    if (params.targets.length === 0) {
      return undefined;
    }
    if (isOwnReactionTarget(params)) {
      return deps.accountLabel?.trim() || "the assistant";
    }
    for (const target of params.targets) {
      const sender =
        target.kind === "phone"
          ? resolveSignalSender({ sourceNumber: target.id })
          : resolveSignalSender({ sourceUuid: target.id });
      if (!sender) {
        continue;
      }
      const displayName = await deps.resolveSenderDisplayName?.(sender);
      if (displayName) {
        return sender.kind === "phone" ? `${displayName} (${sender.e164})` : displayName;
      }
    }
    return params.targets[0]?.display;
  }

  async function dispatchImmediateReactionInbound(params: {
    envelope: SignalEnvelope;
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    emojiLabel: string;
    messageId: string;
    groupId?: string;
    groupName?: string;
    targetLabel?: string;
    targetIsOwn?: boolean;
  }): Promise<void> {
    const isGroup = Boolean(params.groupId);
    const groupLabel = isGroup ? `${params.groupName ?? "Signal Group"} id:${params.groupId}` : undefined;
    const reactionText = deps.buildSignalReactionSystemEventText({
      emojiLabel: params.emojiLabel,
      actorLabel: params.senderName,
      actorId: params.senderDisplay,
      messageId: params.messageId,
      targetLabel: params.targetLabel,
      targetIsOwn: params.targetIsOwn,
      groupLabel,
    });
    const syntheticTimestamp = resolveSignalEventTimestamp(params.envelope.timestamp) ?? Date.now();
    await handleSignalInboundMessage({
      senderName: params.senderName,
      senderDisplay: params.senderDisplay,
      senderRecipient: params.senderRecipient,
      senderPeerId: params.senderPeerId,
      groupId: params.groupId,
      groupName: params.groupName,
      isGroup,
      bodyText: reactionText,
      commandBody: reactionText,
      bodyTextPlain: reactionText,
      timestamp: syntheticTimestamp,
      commandAuthorized: false,
      receivedAtMs: Date.now(),
      preprocessMs: 0,
      attachmentResolveMs: 0,
    });
  }

  async function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    resolveAccessDecision: (isGroup: boolean) => {
      decision: "allow" | "block" | "pairing";
      reason: string;
    };
  }): Promise<boolean> {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove === true || params.reaction.remove === true) {
      return true;
    }
    const emojiLabel = params.reaction.emoji?.trim() || "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? undefined;
    const groupName = params.reaction.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const reactionAccess = params.resolveAccessDecision(isGroup);
    if (reactionAccess.decision !== "allow") {
      logVerbose(`Blocked signal reaction sender ${params.senderDisplay} (${reactionAccess.reason})`);
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const reactionSenderRecipient = resolveSignalRecipient(params.sender);
    const knownOwnMessage = deps.wasSentSignalMessage?.({
      groupId: isGroup ? groupId : undefined,
      recipient: isGroup ? undefined : reactionSenderRecipient,
      messageId: params.reaction.targetSentTimestamp
        ? String(params.reaction.targetSentTimestamp)
        : undefined,
    });
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      accountUuid: deps.accountUuid,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist,
      knownOwnMessage,
    });
    if (!shouldNotify) {
      return true;
    }
    const targetIsOwn = isOwnReactionTarget({
      targets,
      knownOwnMessage,
    });
    const targetLabel = await resolveReactionTargetLabel({
      targets,
      knownOwnMessage,
    });

    const senderPeerId = resolveSignalPeerId(params.sender);
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    if (deps.reactionDelivery === "immediate") {
      await dispatchImmediateReactionInbound({
        envelope: params.envelope,
        senderName,
        senderDisplay: params.senderDisplay,
        senderRecipient: reactionSenderRecipient,
        senderPeerId,
        emojiLabel,
        messageId,
        groupId,
        groupName,
        targetLabel,
        targetIsOwn,
      });
      return true;
    }
    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: deps.cfg,
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupId ?? "unknown") : senderPeerId,
      },
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      actorId: params.senderDisplay,
      messageId,
      targetLabel,
      targetIsOwn,
      groupLabel,
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      SIGNAL_CHANNEL_ID,
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? "",
    ]
      .filter(Boolean)
      .join(":");
    enqueueSignalSystemEvent({
      text,
      sessionKey: route.sessionKey,
      contextKey,
    });
    return true;
  }

  function resolveSignalEventTimestamp(value: number | string | null | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function buildSignalControlSystemEventText(params: {
    actionLabel: "edited" | "deleted" | "pinned" | "unpinned";
    actorLabel: string;
    messageId: string;
    groupLabel?: string;
    previewText?: string;
  }): string {
    const base = `Signal message ${params.actionLabel}: by ${params.actorLabel} msg ${params.messageId}`;
    const withGroup = params.groupLabel ? `${base} in ${params.groupLabel}` : base;
    return params.previewText ? `${withGroup} text="${params.previewText}"` : withGroup;
  }

  function handleSignalControlOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    senderPeerId: string;
    dataMessage?: SignalDataMessage | null;
    messageText: string;
    quoteText: string;
    isGroup: boolean;
    groupId?: string;
    groupName?: string;
  }): boolean {
    const remoteDeleteTimestamp = resolveSignalEventTimestamp(
      params.dataMessage?.remoteDelete?.timestamp ??
        params.dataMessage?.remoteDelete?.targetSentTimestamp,
    );
    const pinTimestamp = resolveSignalEventTimestamp(
      params.dataMessage?.pinMessage?.targetSentTimestamp,
    );
    const unpinTimestamp = resolveSignalEventTimestamp(
      params.dataMessage?.unpinMessage?.targetSentTimestamp,
    );
    const editTimestamp = resolveSignalEventTimestamp(
      params.envelope.editMessage?.targetSentTimestamp,
    );
    const hasEditEnvelope = Boolean(params.envelope.editMessage);

    if (!hasEditEnvelope && !remoteDeleteTimestamp && !pinTimestamp && !unpinTimestamp) {
      return false;
    }

    const hasEditedMessageContent =
      hasEditEnvelope &&
      Boolean(
        params.messageText ||
          params.quoteText ||
          params.dataMessage?.attachments?.length ||
          params.dataMessage?.sticker ||
          params.dataMessage?.contacts?.length ||
          params.dataMessage?.pollCreate ||
          params.dataMessage?.pollVote ||
          params.dataMessage?.pollTerminate,
      );
    if (hasEditedMessageContent) {
      return false;
    }

    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: deps.cfg,
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
      },
    });
    const groupLabel = params.isGroup
      ? `${params.groupName ?? "Signal Group"} id:${params.groupId}`
      : undefined;
    const senderId = formatSignalSenderId(params.sender);
    const emitSystemEvent = (
      kind: "edited" | "deleted" | "pinned" | "unpinned",
      messageId: string,
      text: string,
    ) => {
      const contextKey = [
        SIGNAL_CHANNEL_ID,
        "message",
        kind,
        messageId,
        senderId,
        params.groupId ?? "",
      ]
        .filter(Boolean)
        .join(":");
      enqueueSignalSystemEvent({ text, sessionKey: route.sessionKey, contextKey });
    };

    if (remoteDeleteTimestamp) {
      const messageId = String(remoteDeleteTimestamp);
      emitSystemEvent(
        "deleted",
        messageId,
        buildSignalControlSystemEventText({
          actionLabel: "deleted",
          actorLabel: senderName,
          messageId,
          groupLabel,
        }),
      );
      return true;
    }

    if (pinTimestamp) {
      const messageId = String(pinTimestamp);
      emitSystemEvent(
        "pinned",
        messageId,
        buildSignalControlSystemEventText({
          actionLabel: "pinned",
          actorLabel: senderName,
          messageId,
          groupLabel,
        }),
      );
      return true;
    }

    if (unpinTimestamp) {
      const messageId = String(unpinTimestamp);
      emitSystemEvent(
        "unpinned",
        messageId,
        buildSignalControlSystemEventText({
          actionLabel: "unpinned",
          actorLabel: senderName,
          messageId,
          groupLabel,
        }),
      );
      return true;
    }

    if (hasEditEnvelope) {
      const fallbackTimestamp =
        resolveSignalEventTimestamp(params.dataMessage?.timestamp) ??
        resolveSignalEventTimestamp(params.envelope.timestamp);
      const messageId = String(editTimestamp ?? fallbackTimestamp ?? "unknown");
      const previewSource = (params.messageText || params.quoteText || "").replace(/\s+/g, " ").trim();
      const previewText =
        previewSource.length > 140 ? `${previewSource.slice(0, 137)}...` : previewSource;
      emitSystemEvent(
        "edited",
        messageId,
        buildSignalControlSystemEventText({
          actionLabel: "edited",
          actorLabel: senderName,
          messageId,
          groupLabel,
          previewText,
        }),
      );
      return true;
    }

    return false;
  }

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null = null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }

    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }

    const normalizedAccount = deps.account ? normalizeSignalAllowRecipient(deps.account) : undefined;
    const isOwnMessage =
      (sender.kind === "phone" && normalizedAccount != null && sender.e164 === normalizedAccount) ||
      (sender.kind === "uuid" && deps.accountUuid != null && sender.raw === deps.accountUuid);
    if (isOwnMessage) {
      return;
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const editTargetTimestamp = resolveSignalEventTimestamp(envelope.editMessage?.targetSentTimestamp) ?? undefined;
    const isEditMessage = Boolean(envelope.editMessage);
    const maybeGroupId = dataMessage?.groupInfo?.groupId ?? undefined;

    if ("syncMessage" in envelope && !maybeGroupId) {
      return;
    }

    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;
    const dedupeKey = buildSignalInboundDedupeKey({
      envelope,
      sender,
      dataMessage,
      groupId: maybeGroupId,
      reaction,
      isEditMessage,
      editTargetTimestamp,
    });
    if (dedupeKey && recentInboundDeduper.recordAndCheckDuplicate(dedupeKey)) {
      logVerbose(`Signal duplicate inbound dropped: ${dedupeKey}`);
      return;
    }

    const senderDisplay = formatSignalSenderDisplay(sender);
    const senderName =
      normalizeSenderNameValue(envelope.sourceName) ??
      (await deps.resolveSenderDisplayName?.(sender)) ??
      senderDisplay;

    const rawMessage = dataMessage?.message ?? "";
    const mentionResult = await renderSignalMentions(rawMessage, dataMessage?.mentions, {
      resolveMentionLabel: deps.resolveMentionDisplayName,
    });
    const normalizedMessage = mentionResult.text;
    const adjustedTextStyles =
      dataMessage?.textStyles && mentionResult.offsetShifts.size > 0
        ? (() => {
            const shiftPositions = Array.from(mentionResult.offsetShifts.keys()).sort((a, b) => a - b);
            const cumulativeShiftAtOffset = (offset: number): number => {
              let cumulativeShift = 0;
              for (const shiftPosition of shiftPositions) {
                if (shiftPosition <= offset) {
                  cumulativeShift += mentionResult.offsetShifts.get(shiftPosition) ?? 0;
                } else {
                  break;
                }
              }
              return cumulativeShift;
            };
            return dataMessage.textStyles.map((style) => {
              if (typeof style.start !== "number") {
                return style;
              }
              const adjustedStart = style.start + cumulativeShiftAtOffset(style.start);
              if (typeof style.length !== "number") {
                return {
                  ...style,
                  start: adjustedStart,
                };
              }
              const styleEnd = style.start + style.length;
              const adjustedEnd = styleEnd + cumulativeShiftAtOffset(styleEnd);
              return {
                ...style,
                start: adjustedStart,
                length: Math.max(0, adjustedEnd - adjustedStart),
              };
            });
          })()
        : dataMessage?.textStyles;
    const styledMessage =
      deps.preserveTextStyles !== false
        ? applySignalTextStyles(normalizedMessage, adjustedTextStyles)
        : normalizedMessage;
    const messageTextPlain = normalizedMessage.trim();
    const messageText = styledMessage.trim();

    const quote = dataMessage?.quote;
    const quoteText = quote?.text?.trim() ?? "";
    const quoteId = (() => {
      const raw = quote?.id ?? quote?.timestamp;
      if (raw == null) {
        return undefined;
      }
      const value = String(raw).trim();
      return value || undefined;
    })();
    const quoteAuthor = (() => {
      const raw = quote?.authorUuid ?? quote?.authorNumber ?? quote?.author;
      if (typeof raw !== "string") {
        return undefined;
      }
      const value = raw.trim();
      return value || undefined;
    })();
    const storyContextAuthor =
      normalizeSignalStoryAuthor(dataMessage?.storyContext?.authorUuid) ??
      normalizeSignalStoryAuthor(dataMessage?.storyContext?.authorNumber);
    const storyContextTimestamp = normalizeStoryTimestamp(dataMessage?.storyContext?.sentTimestamp);
    const sticker = dataMessage?.sticker;
    const stickerPackId = sticker?.packId != null ? String(sticker.packId).trim() || undefined : undefined;
    const stickerId = sticker?.stickerId != null ? String(sticker.stickerId).trim() || undefined : undefined;
    const stickerContext = [
      stickerPackId ? `Signal sticker packId: ${stickerPackId}` : undefined,
      stickerId ? `Signal stickerId: ${stickerId}` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    const linkPreviewContext =
      deps.injectLinkPreviews !== false ? buildSignalLinkPreviewContext(dataMessage?.previews) : [];
    const storyContextLines = buildSignalStoryContext({
      author: storyContextAuthor,
      timestamp: storyContextTimestamp,
    });
    const contactContext = buildSignalContactContext(dataMessage?.contacts);
    const pollCreate = dataMessage?.pollCreate ?? null;
    const pollVote = dataMessage?.pollVote ?? null;
    const pollTerminate = dataMessage?.pollTerminate ?? null;
    const pollContext = buildSignalPollContext({ pollCreate, pollVote, pollTerminate });
    const attachments = dataMessage?.attachments ?? [];
    const allAttachments = sticker?.attachment ? [...attachments, sticker.attachment] : attachments;
    const { resolveAccessDecision, dmAccess, effectiveDmAllow, effectiveGroupAllow } =
      await resolveSignalAccessState({
        accountId: deps.accountId,
        dmPolicy: deps.dmPolicy,
        groupPolicy: deps.groupPolicy,
        allowFrom: deps.allowFrom,
        groupAllowFrom: deps.groupAllowFrom,
        sender,
      });

    const bareReaction = dataMessage?.reaction;
    const hasBareReactionField = !reaction && Boolean(bareReaction) && !messageText && !quoteText;
    if (hasBareReactionField && bareReaction) {
      const senderDisplayBare = senderDisplay;
      const emojiLabel =
        typeof bareReaction.emoji === "string" ? bareReaction.emoji.trim() || "emoji" : "emoji";
      const isRemove = bareReaction.isRemove === true || bareReaction.remove === true;
      const targetTimestamp = resolveSignalEventTimestamp(bareReaction.targetSentTimestamp);
      logVerbose(`signal: bare reaction (${emojiLabel}) from ${senderDisplayBare}`);
      if (!isRemove) {
        const groupId = bareReaction.groupInfo?.groupId ?? dataMessage?.groupInfo?.groupId ?? undefined;
        const groupName =
          bareReaction.groupInfo?.groupName ?? dataMessage?.groupInfo?.groupName ?? undefined;
        const isGroup = Boolean(groupId);
        const bareAccessDecision = resolveAccessDecision(isGroup);
        if (bareAccessDecision.decision !== "allow") {
          logVerbose(
            `signal: bare reaction from unauthorized sender ${senderDisplayBare}, dropping (${bareAccessDecision.reason})`,
          );
          return;
        }
        const bareReactionTargets = deps.resolveSignalReactionTargets(bareReaction);
        const bareReactionSenderRecipient = resolveSignalRecipient(sender);
        const knownOwnMessage = deps.wasSentSignalMessage?.({
          groupId: isGroup ? groupId : undefined,
          recipient: isGroup ? undefined : bareReactionSenderRecipient,
          messageId: targetTimestamp ? String(targetTimestamp) : undefined,
        });
        const shouldNotifyBare = deps.shouldEmitSignalReactionNotification({
          mode: deps.reactionMode,
          account: deps.account,
          accountUuid: deps.accountUuid,
          targets: bareReactionTargets,
          sender,
          allowlist: deps.reactionAllowlist,
          knownOwnMessage,
        });
        if (!shouldNotifyBare) {
          logVerbose(`signal: bare reaction suppressed (reactionMode=${deps.reactionMode})`);
          return;
        }
        const targetIsOwn = isOwnReactionTarget({
          targets: bareReactionTargets,
          knownOwnMessage,
        });
        const targetLabel = await resolveReactionTargetLabel({
          targets: bareReactionTargets,
          knownOwnMessage,
        });
        const senderPeerIdBare = resolveSignalPeerId(sender);
        const routeBare = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg: deps.cfg,
          channel: SIGNAL_CHANNEL_ID,
          accountId: deps.accountId,
          peer: {
            kind: isGroup ? "group" : "direct",
            id: isGroup ? (groupId ?? "unknown") : senderPeerIdBare,
          },
        });
        const messageId = targetTimestamp ? String(targetTimestamp) : "unknown";
        if (deps.reactionDelivery === "immediate") {
          await dispatchImmediateReactionInbound({
            envelope,
            senderName,
            senderDisplay: senderDisplayBare,
            senderRecipient: bareReactionSenderRecipient,
            senderPeerId: senderPeerIdBare,
            emojiLabel,
            messageId,
            groupId,
            groupName,
            targetLabel,
            targetIsOwn,
          });
          return;
        }
        const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
        const text = deps.buildSignalReactionSystemEventText({
          emojiLabel,
          actorLabel: senderName,
          actorId: senderDisplayBare,
          messageId,
          targetLabel,
          targetIsOwn,
          groupLabel,
        });
        enqueueSignalSystemEvent({
          text,
          sessionKey: routeBare.sessionKey,
          contextKey: [
            SIGNAL_CHANNEL_ID,
            "reaction",
            "added",
            messageId,
            senderPeerIdBare,
            emojiLabel,
            groupId ?? "",
          ]
            .filter(Boolean)
            .join(":"),
        });
      }
      return;
    }
    const hasBodyContent = Boolean(messageText || quoteText) || Boolean(!reaction && allAttachments.length > 0);

    if (
      reaction &&
      (await handleReactionOnlyInbound({
        envelope,
        sender,
        senderDisplay,
        reaction,
        hasBodyContent,
        resolveAccessDecision,
      }))
    ) {
      return;
    }
    const storyMessage = envelope.storyMessage;
    if (storyMessage) {
      const receivedAtMs = Date.now();
      if (deps.ignoreStories) {
        logVerbose("signal: skipping story message (ignoreStories=true)");
        return;
      }
      const senderRecipient = resolveSignalRecipient(sender);
      const senderPeerId = resolveSignalPeerId(sender);
      if (!senderRecipient) {
        return;
      }
      const groupId = storyMessage.groupId?.trim() || undefined;
      const isGroup = Boolean(groupId);
      const mediaAttachment = storyMessage.fileAttachment ?? undefined;
      const storyMediaPromise =
        !deps.ignoreAttachments && mediaAttachment?.id
          ? deps.fetchAttachment({
              baseUrl: deps.baseUrl,
              account: deps.account,
              attachment: mediaAttachment,
              sender: senderRecipient,
              groupId,
              maxBytes: deps.mediaMaxBytes,
            })
          : null;
      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let mediaPaths: string[] | undefined;
      let mediaTypes: string[] | undefined;
      const storyAttachmentStartedAt = Date.now();
      if (storyMediaPromise) {
        const fetched = await storyMediaPromise;
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? mediaAttachment?.contentType ?? undefined;
          mediaPaths = [fetched.path];
          mediaTypes = [mediaType ?? "application/octet-stream"];
        }
      }
      const attachmentResolveMs = storyMediaPromise ? Math.max(0, Date.now() - storyAttachmentStartedAt) : 0;
      const storyText = storyMessage.textAttachment?.text?.trim() ?? "";
      const storyAuthor = sender.kind === "phone" ? (sender.uuid ?? senderRecipient) : sender.raw;
      const storyTimestamp = normalizeStoryTimestamp(envelope.timestamp);
      const storyContext = buildSignalStoryContext({
        author: storyAuthor,
        timestamp: storyTimestamp,
        allowsReplies: storyMessage.allowsReplies === true,
      });
      const previewContext = buildSignalLinkPreviewContext(
        storyMessage.textAttachment?.preview ? [storyMessage.textAttachment.preview] : undefined,
      );
      const kind = resolveSignalMediaKind(mediaType ?? mediaAttachment?.contentType ?? undefined);
      const placeholder = kind ? `<media:${kind}>` : mediaAttachment ? "<media:attachment>" : "[Signal story]";
      const bodyText = storyText || placeholder;
      await inboundDebouncer.enqueue({
        senderName,
        senderDisplay,
        senderRecipient,
        senderPeerId,
        groupId,
        isGroup,
        bodyText,
        commandBody: storyText || bodyText,
        bodyTextPlain: storyText || bodyText,
        timestamp: envelope.timestamp ?? undefined,
        messageId: typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        mediaPath,
        mediaType,
        mediaPaths,
        mediaTypes,
        untrustedContext:
          [...storyContext, ...previewContext].length > 0
            ? [...storyContext, ...previewContext]
            : undefined,
        commandAuthorized: true,
        replyToIsStory: true,
        storyReplyTimestamp: storyMessage.allowsReplies === true ? storyTimestamp : undefined,
        storyReplyAuthor: storyMessage.allowsReplies === true ? storyAuthor : undefined,
        receivedAtMs,
        preprocessMs: Math.max(0, Date.now() - receivedAtMs),
        attachmentResolveMs,
      });
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupId = dataMessage.groupInfo?.groupId ?? undefined;
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const signalGroupRuntime = isGroup
      ? resolveSignalGroupRuntimeConfig({
          cfg: deps.cfg,
          groupId,
          accountId: deps.accountId,
        })
      : undefined;
    if (isGroup && signalGroupRuntime?.enabled === false) {
      logVerbose(`Blocked signal group ${groupId} (groups.${groupId}.enabled=false)`);
      return;
    }

    const isTimerUpdate =
      !messageText &&
      !quoteText &&
      allAttachments.length === 0 &&
      (dataMessage.isExpirationUpdate === true ||
        (typeof dataMessage.expiresInSeconds === "number" && dataMessage.expiresInSeconds > 0));
    const isGroupV2Change = Boolean(dataMessage.groupV2Change);
    if (isTimerUpdate || isGroupV2Change) {
      logVerbose(
        `signal: skipping system message (isTimerUpdate=${isTimerUpdate}, isGroupV2Change=${isGroupV2Change})`,
      );
      return;
    }

    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        dmPolicy: deps.dmPolicy,
        dmAccessDecision: dmAccess.decision,
        senderId: senderAllowId,
        senderIdLine,
        senderDisplay,
        senderName,
        accountId: deps.accountId,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`${SIGNAL_CHANNEL_ID}:${senderRecipient}`, text, {
            cfg: deps.cfg,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId,
          });
        },
        log: logVerbose,
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      const groupAllowFromOverrideConfigured = signalGroupRuntime?.allowFromConfigured === true;
      const effectiveGroupAllowFrom = groupAllowFromOverrideConfigured
        ? (signalGroupRuntime?.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean)
        : deps.groupAllowFrom;

      if (deps.groupPolicy === "disabled") {
        logVerbose("Blocked signal group message (groupPolicy: disabled)");
        return;
      }

      if (groupAllowFromOverrideConfigured) {
        if (!isSignalSenderAllowed(sender, effectiveGroupAllowFrom)) {
          logVerbose(
            `Blocked signal group sender ${senderDisplay} (not in groups.${groupId}.allowFrom)`,
          );
          return;
        }
      } else {
        const groupAccess = resolveAccessDecision(true);
        if (groupAccess.decision !== "allow") {
          if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
            logVerbose("Blocked signal group message (groupPolicy: disabled)");
          } else if (
            groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST
          ) {
            logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
          } else {
            logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
          }
          return;
        }
      }
    }

    const inboundMediaPromise =
      !deps.ignoreAttachments && allAttachments.length > 0
        ? fetchInboundMediaBundle({
            attachments: allAttachments,
            senderRecipient,
            groupId,
          })
        : null;
    const receivedAtMs = Date.now();

    if (
      handleSignalControlOnlyInbound({
        envelope,
        sender,
        senderDisplay,
        senderPeerId,
        dataMessage,
        messageText,
        quoteText,
        isGroup,
        groupId,
        groupName,
      })
    ) {
      return;
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const commandDmAllow = isGroup ? deps.allowFrom : effectiveDmAllow;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, commandDmAllow);
    const groupAllowFromForCommands =
      isGroup && signalGroupRuntime?.allowFromConfigured
        ? (signalGroupRuntime.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean)
        : effectiveGroupAllow;
    const groupAllowedForCommands = isSignalSenderAllowed(sender, groupAllowFromForCommands);
    const hasControlCommandInMessage = pluginRuntime.channel.text.hasControlCommand(
      messageTextPlain,
      deps.cfg,
    );
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: groupAllowFromForCommands.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });
    const commandAuthorized = commandGate.commandAuthorized;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: SIGNAL_CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: deps.cfg,
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupId ?? "unknown") : senderPeerId,
      },
    });
    const mentionRegexes = pluginRuntime.channel.mentions.buildMentionRegexes(
      deps.cfg,
      route.agentId,
    );
    const wasMentioned = isGroup && pluginRuntime.channel.mentions.matchesMentionPatterns(
      messageTextPlain,
      mentionRegexes,
    );
    const mentionMetadata = dataMessage.mentions ?? undefined;
    const hasMentionMetadata = hasMentionTargetMetadata(mentionMetadata);
    const wasMentionedByMetadata =
      isGroup &&
      isMentionedBySignalMetadata({
        mentions: mentionMetadata,
        account: deps.account,
        accountUuid: deps.accountUuid,
      });
    const requireMention = isGroup && (signalGroupRuntime?.requireMention ?? true);
    const canDetectMention = mentionRegexes.length > 0 || Boolean(deps.account || deps.accountUuid);
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      wasMentioned,
      implicitMention: wasMentionedByMetadata,
      hasAnyMention: hasMentionMetadata,
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    });
    const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: SIGNAL_CHANNEL_ID,
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (sticker) {
          return "<media:sticker>";
        }
        if (allAttachments.length === 0) {
          return "";
        }
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const firstContentType = allAttachments[0]?.contentType;
        const pendingKind = resolveSignalMediaKind(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || quoteText;
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: senderName,
          body: pendingBodyText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        },
      });
      return;
    }

    const ackTimestamp =
      resolveSignalEventTimestamp(envelope.timestamp) ??
      resolveSignalEventTimestamp(dataMessage.timestamp);
    const hasEarlyBody =
      Boolean(messageText || quoteText) ||
      Boolean(!deps.ignoreAttachments && allAttachments.length > 0);
    const ackEmoji = resolveAckReaction(deps.cfg, route.agentId, {
      channel: SIGNAL_CHANNEL_ID,
      accountId: deps.accountId,
    }).trim();
    const shouldSendAckReaction =
      hasEarlyBody &&
      Boolean(ackTimestamp) &&
      Boolean(ackEmoji) &&
      shouldAckReaction({
        scope: deps.cfg.messages?.ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup && canDetectMention,
        requireMention: Boolean(requireMention),
        canDetectMention,
        effectiveWasMentioned: effectiveWasMentioned ?? false,
        shouldBypassMention: !requireMention,
      });

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaCaption: string | undefined;
    let mediaPaths: string[] | undefined;
    let mediaTypes: string[] | undefined;
    let mediaCaptions: string[] | undefined;
    let mediaDimension: { width?: number; height?: number } | undefined;
    let mediaDimensions: Array<{ width?: number; height?: number }> | undefined;
    let placeholder = "";
    const attachmentStartedAt = Date.now();
    if (inboundMediaPromise) {
      ({
        mediaPath,
        mediaType,
        mediaCaption,
        mediaPaths,
        mediaTypes,
        mediaCaptions,
        mediaDimension,
        mediaDimensions,
      } = await inboundMediaPromise);
    }
    const attachmentResolveMs = inboundMediaPromise
      ? Math.max(0, Date.now() - attachmentStartedAt)
      : 0;

    const kind = resolveSignalMediaKind(mediaType ?? allAttachments[0]?.contentType ?? undefined);
    if (sticker) {
      placeholder = "<media:sticker>";
    } else if (kind && kind !== "unknown") {
      placeholder = `<media:${kind}>`;
    } else if (allAttachments.length > 0) {
      placeholder = "<media:attachment>";
    } else if (Array.isArray(dataMessage?.contacts) && dataMessage.contacts.length > 0) {
      placeholder = "<media:contact>";
    } else if (pollCreate) {
      placeholder = `[Poll] ${pollCreate.question?.trim() || "Untitled"}`;
    } else if (pollVote) {
      placeholder = "[Poll vote]";
    } else if (pollTerminate) {
      placeholder = "[Poll closed]";
    }

    const bodyText = messageText || placeholder || quoteText;
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      void sendReadReceiptSignal(`${SIGNAL_CHANNEL_ID}:${senderRecipient}`, receiptTimestamp, {
        cfg: deps.cfg,
        accountId: deps.accountId,
      }).catch((err) => {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      });
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const messageId =
      typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined;
    const attachmentContext = buildSignalAttachmentDetailContext({
      captions: mediaCaptions,
      dimensions: mediaDimensions,
    });
    const editContext =
      typeof editTargetTimestamp === "number" ? [`Signal edit target: ${editTargetTimestamp}`] : [];
    const untrustedContext = [
      ...attachmentContext,
      ...stickerContext,
      ...linkPreviewContext,
      ...storyContextLines,
      ...contactContext,
      ...pollContext,
      ...editContext,
    ];
    if (messageId) {
      recordSignalReactionTarget({
        groupId,
        recipient: !isGroup ? senderRecipient : undefined,
        messageId,
        senderId:
          sender.kind === "phone" && sender.uuid
            ? `uuid:${sender.uuid}`
            : senderPeerId,
        senderE164: sender.kind === "phone" ? sender.e164 : undefined,
      });
    }
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText || bodyText,
      bodyTextPlain: messageTextPlain || bodyText,
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      editTargetTimestamp,
      isEdit: isEditMessage,
      mediaPath,
      mediaType,
      mediaCaption,
      mediaPaths,
      mediaTypes,
      mediaCaptions,
      mediaDimension,
      mediaDimensions,
      untrustedContext: untrustedContext.length > 0 ? untrustedContext : undefined,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
      shouldAckReaction: shouldSendAckReaction,
      ackTargetTimestamp: ackTimestamp ?? undefined,
      statusReactionTargetAuthor: sender.kind === "phone" ? sender.e164 : undefined,
      statusReactionTargetAuthorUuid: sender.kind === "phone" ? sender.uuid : sender.raw,
      replyToId: quoteId,
      replyToBody: quoteText || undefined,
      replyToSender: quoteAuthor,
      replyToIsQuote: quote ? true : undefined,
      replyToIsStory: storyContextTimestamp !== undefined,
      receivedAtMs,
      preprocessMs: Math.max(0, Date.now() - receivedAtMs),
      attachmentResolveMs,
    });
  };
}
