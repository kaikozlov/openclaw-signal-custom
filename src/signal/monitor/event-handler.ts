import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createReplyPrefixOptions,
  createTypingCallbacks,
  DM_GROUP_ACCESS_REASON,
  formatInboundFromLabel,
  logInboundDrop,
  logTypingFailure,
  normalizeE164,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
} from "openclaw/plugin-sdk";
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
import { recordSignalReactionTarget } from "../reaction-target-cache.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import { maybeSendSignalAckReaction } from "./ack-reaction.js";
import type {
  SignalDataMessage,
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalMention,
  SignalReactionMessage,
  SignalReceivePayload,
  SignalTextStyleRange,
} from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";

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
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };

  const pluginRuntime = getSignalRuntime();
  const logVerbose = (message: string) => {
    if (pluginRuntime.logging.shouldLogVerbose()) {
      deps.runtime.log?.(message);
    }
  };

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
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
    const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
      Body: combinedBody,
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
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: SIGNAL_CHANNEL_ID,
      accountId: route.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
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
    });

    const { queuedFinal } =
      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: deps.cfg,
        dispatcherOptions: {
          ...prefixOptions,
          humanDelay: pluginRuntime.channel.reply.resolveHumanDelayConfig(deps.cfg, route.agentId),
          typingCallbacks,
          deliver: async (payload) => {
            await deps.deliverReplies({
              replies: [payload],
              target: ctxPayload.To,
              baseUrl: deps.baseUrl,
              account: deps.account,
              accountId: deps.accountId,
              runtime: deps.runtime,
              maxBytes: deps.mediaMaxBytes,
              textLimit: deps.textLimit,
              quoteAuthor: entry.senderRecipient || undefined,
            });
          },
          onError: (err, info) => {
            deps.runtime.error?.(`signal ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyOptions: {
          disableBlockStreaming:
            typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
          onModelSelected,
        },
      });

    if (!queuedFinal) {
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
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    resolveAccessDecision: (isGroup: boolean) => {
      decision: "allow" | "block" | "pairing";
      reason: string;
    };
  }): boolean {
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
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist,
    });
    if (!shouldNotify) {
      return true;
    }

    const senderPeerId = resolveSignalPeerId(params.sender);
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
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      messageId,
      targetLabel: targets[0]?.display,
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
    pluginRuntime.system.enqueueSystemEvent(text, {
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
      pluginRuntime.system.enqueueSystemEvent(text, { sessionKey: route.sessionKey, contextKey });
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

    const rawMessage = dataMessage?.message ?? "";
    const mentionResult = renderSignalMentions(rawMessage, dataMessage?.mentions);
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
    const sticker = dataMessage?.sticker;
    const stickerPackId = sticker?.packId != null ? String(sticker.packId).trim() || undefined : undefined;
    const stickerId = sticker?.stickerId != null ? String(sticker.stickerId).trim() || undefined : undefined;
    const stickerContext = [
      stickerPackId ? `Signal sticker packId: ${stickerPackId}` : undefined,
      stickerId ? `Signal stickerId: ${stickerId}` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    const linkPreviewContext =
      deps.injectLinkPreviews !== false ? buildSignalLinkPreviewContext(dataMessage?.previews) : [];
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
      const senderDisplayBare = formatSignalSenderDisplay(sender);
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
        const shouldNotifyBare = deps.shouldEmitSignalReactionNotification({
          mode: deps.reactionMode,
          account: deps.account,
          targets: bareReactionTargets,
          sender,
          allowlist: deps.reactionAllowlist,
        });
        if (!shouldNotifyBare) {
          logVerbose(`signal: bare reaction suppressed (reactionMode=${deps.reactionMode})`);
          return;
        }
        const senderName = envelope.sourceName ?? senderDisplayBare;
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
        const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
        const text = deps.buildSignalReactionSystemEventText({
          emojiLabel,
          actorLabel: senderName,
          messageId,
          groupLabel,
        });
        pluginRuntime.system.enqueueSystemEvent(text, {
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
    const senderDisplay = formatSignalSenderDisplay(sender);

    if (
      reaction &&
      handleReactionOnlyInbound({
        envelope,
        sender,
        senderDisplay,
        reaction,
        hasBodyContent,
        resolveAccessDecision,
      })
    ) {
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
    const channelGroupPolicy = isGroup
      ? pluginRuntime.channel.groups.resolveGroupPolicy({
          cfg: deps.cfg,
          channel: SIGNAL_CHANNEL_ID,
          groupId,
          accountId: deps.accountId,
          hasGroupAllowFrom: deps.groupAllowFrom.length > 0,
        })
      : undefined;
    const groupExplicitlyAllowed = Boolean(
      channelGroupPolicy?.allowed && (channelGroupPolicy.groupConfig || channelGroupPolicy.defaultConfig),
    );

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
        senderName: envelope.sourceName ?? undefined,
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
      if (!channelGroupPolicy?.allowed) {
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
      } else if (deps.groupAllowFrom.length > 0) {
        const groupAccess = resolveAccessDecision(true);
        if (groupAccess.decision !== "allow") {
          logVerbose(
            `Blocked signal group sender ${senderDisplay} (group allowed, sender not in groupAllowFrom)`,
          );
          return;
        }
      }
    }

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
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = pluginRuntime.channel.text.hasControlCommand(
      messageTextPlain,
      deps.cfg,
    );
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
        { configured: groupExplicitlyAllowed, allowed: groupExplicitlyAllowed },
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
    const requireMention =
      isGroup &&
      pluginRuntime.channel.groups.resolveRequireMention({
        cfg: deps.cfg,
        channel: SIGNAL_CHANNEL_ID,
        groupId,
        accountId: deps.accountId,
      });
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
          sender: envelope.sourceName ?? senderDisplay,
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
    if (hasEarlyBody && ackTimestamp) {
      maybeSendSignalAckReaction({
        cfg: deps.cfg,
        agentId: route.agentId,
        sender,
        targetTimestamp: ackTimestamp,
        isGroup,
        groupId,
        wasMentioned: effectiveWasMentioned,
        canDetectMention,
        requireMention: Boolean(requireMention),
        accountId: deps.accountId,
        onError: (err) => {
          logVerbose(`Signal ack reaction failed: ${String(err)}`);
        },
      });
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaCaption: string | undefined;
    let mediaPaths: string[] | undefined;
    let mediaTypes: string[] | undefined;
    let mediaCaptions: string[] | undefined;
    let mediaDimension: { width?: number; height?: number } | undefined;
    let mediaDimensions: Array<{ width?: number; height?: number }> | undefined;
    let placeholder = "";
    if (!deps.ignoreAttachments && allAttachments.length > 0) {
      const fetchedMedia: Array<{
        path: string;
        contentType?: string;
        caption?: string;
        width?: number;
        height?: number;
      }> = [];
      const fetchResults = await Promise.allSettled(
        allAttachments.map(async (attachment) => {
          if (!attachment?.id) {
            return null;
          }
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
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
        }),
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
      if (fetchedMedia.length > 0) {
        mediaPath = fetchedMedia[0]?.path;
        mediaType = fetchedMedia[0]?.contentType ?? allAttachments[0]?.contentType ?? undefined;
        mediaCaption = fetchedMedia[0]?.caption;
        mediaPaths = fetchedMedia.map((entry) => entry.path);
        mediaTypes = fetchedMedia.map((entry) => entry.contentType ?? "application/octet-stream");
        mediaCaptions = fetchedMedia.map((entry) => entry.caption ?? "");
        if (!mediaCaptions.some((entry) => entry.trim().length > 0)) {
          mediaCaptions = undefined;
        }
        const fetchedDimensions = fetchedMedia.map((entry) => ({
          width: entry.width,
          height: entry.height,
        }));
        if (fetchedDimensions.some((entry) => entry.width || entry.height)) {
          mediaDimension = fetchedDimensions[0];
          mediaDimensions = fetchedDimensions;
        }
      }
    }

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
      try {
        await sendReadReceiptSignal(`${SIGNAL_CHANNEL_ID}:${senderRecipient}`, receiptTimestamp, {
          cfg: deps.cfg,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
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
      ...contactContext,
      ...pollContext,
      ...editContext,
    ];
    if (isGroup && groupId && messageId) {
      recordSignalReactionTarget({
        groupId,
        messageId,
        senderId: senderPeerId,
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
      replyToId: quoteId,
      replyToBody: quoteText || undefined,
      replyToSender: quoteAuthor,
      replyToIsQuote: quote ? true : undefined,
    });
  };
}
