import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createReplyPrefixOptions,
  createTypingCallbacks,
  DM_GROUP_ACCESS_REASON,
  formatInboundFromLabel,
  logInboundDrop,
  logTypingFailure,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
} from "openclaw/plugin-sdk";
import { SIGNAL_CHANNEL_ID } from "../../constants.js";
import { getSignalRuntime } from "../../runtime.js";
import { normalizeSignalCustomMessagingTarget } from "../../targets.js";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "../inbound-debounce.js";
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
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalReactionMessage,
  SignalReceivePayload,
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
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    commandAuthorized: boolean;
    wasMentioned?: boolean;
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
      Timestamp: entry.timestamp ?? undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: SIGNAL_CHANNEL_ID,
      OriginatingTo: signalTo,
    });

    await pluginRuntime.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup
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
      return shouldDebounceTextInbound({
        text: entry.bodyText,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType),
      });
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
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
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
    if (params.reaction.isRemove) {
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
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();

    const quoteText = dataMessage?.quote?.text?.trim() ?? "";
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
      const emojiLabel = bareReaction.emoji?.trim() || "emoji";
      const isRemove = Boolean(bareReaction.isRemove);
      const targetTimestamp = bareReaction.targetSentTimestamp;
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
        const messageId = typeof targetTimestamp === "number" ? String(targetTimestamp) : "unknown";
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

    const hasBodyContent =
      Boolean(messageText || quoteText) || Boolean(!reaction && dataMessage?.attachments?.length);
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

    const isTimerUpdate =
      !messageText &&
      !quoteText &&
      !dataMessage.attachments?.length &&
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
      const groupAccess = resolveAccessDecision(true);
      if (groupAccess.decision !== "allow") {
        if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const commandDmAllow = isGroup ? deps.allowFrom : effectiveDmAllow;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, commandDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = pluginRuntime.channel.text.hasControlCommand(
      messageText,
      deps.cfg,
    );
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
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
      messageText,
      mentionRegexes,
    );
    const requireMention =
      isGroup &&
      pluginRuntime.channel.groups.resolveRequireMention({
        cfg: deps.cfg,
        channel: SIGNAL_CHANNEL_ID,
        groupId,
        accountId: deps.accountId,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      wasMentioned,
      implicitMention: false,
      hasAnyMention: false,
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
      const quoteText = dataMessage.quote?.text?.trim() || "";
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = pluginRuntime.media.mediaKindFromMime(firstContentType ?? undefined);
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

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let placeholder = "";
    const firstAttachment = dataMessage.attachments?.[0];
    if (firstAttachment?.id && !deps.ignoreAttachments) {
      try {
        const fetched = await deps.fetchAttachment({
          baseUrl: deps.baseUrl,
          account: deps.account,
          attachment: firstAttachment,
          sender: senderRecipient,
          groupId,
          maxBytes: deps.mediaMaxBytes,
        });
        if (fetched) {
          mediaPath = fetched.path;
          mediaType = fetched.contentType ?? firstAttachment.contentType ?? undefined;
        }
      } catch (err) {
        deps.runtime.error?.(`attachment fetch failed: ${String(err)}`);
      }
    }

    const kind = mediaType ? pluginRuntime.media.mediaKindFromMime(mediaType) : undefined;
    if (kind && kind !== "unknown") {
      placeholder = `<media:${kind}>`;
    } else if (kind === "unknown" || (!kind && dataMessage.attachments?.length)) {
      placeholder = "<media:attachment>";
    }

    const bodyText = messageText || placeholder || dataMessage.quote?.text?.trim() || "";
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
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText,
      timestamp: envelope.timestamp ?? undefined,
      messageId,
      mediaPath,
      mediaType,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
    });
  };
}
