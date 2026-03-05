import {
  applyAccountNameToChannelSection,
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  chunkTextForOutbound,
  collectStatusIssuesFromLastError,
  createActionGate,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  jsonResult,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  PAIRING_APPROVED_MESSAGE,
  readNumberParam,
  resolveChannelMediaMaxBytes,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  readStringParam,
  setAccountEnabledInConfigSection,
  type ChannelGroupContext,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  getSignalConfig,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  SignalConfigSchema,
  type ResolvedSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID, SIGNAL_META, stripSignalChannelPrefix } from "./constants.js";
import { signalOnboardingAdapter } from "./onboarding.js";
import { getSignalRuntime } from "./runtime.js";
import {
  markdownToSignalTextChunks,
  type SignalTextStyleRange,
} from "./signal/format.js";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  sendStickerSignal,
} from "./signal/send-actions.js";
import {
  sendMessageSignal,
  type SignalMentionRange,
  type SignalSendOpts,
  type SignalSendResult,
} from "./signal/send.js";
import { removeReactionSignal, sendReactionSignal } from "./signal/send-reactions.js";
import { listSignalContacts, listSignalGroups } from "./signal/directory.js";
import {
  addGroupMemberSignal,
  listGroupMembersSignal,
  quitGroupSignal,
  removeGroupMemberSignal,
  updateGroupSignal,
} from "./signal/groups.js";
import {
  looksLikeSignalCustomTargetId,
  normalizeSignalCustomMessagingTarget,
} from "./targets.js";

type ReactionToolContext = {
  currentMessageId?: string | number;
};

const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const runtimeActions = getSignalRuntime().channel.signal.messageActions?.listActions?.({ cfg }) ?? [];
    const actions = new Set(runtimeActions);
    const configuredAccounts = listSignalAccountIds(cfg)
      .map((accountId) => resolveSignalAccount({ cfg, accountId }))
      .filter((account) => account.enabled && account.configured);
    if (configuredAccounts.length === 0) {
      return Array.from(actions);
    }
    if (actions.size === 0) {
      actions.add("send");
    }
    const reactionsEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("reactions"),
    );
    if (reactionsEnabled) {
      actions.add("react");
    }
    const editEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("editMessage"),
    );
    if (editEnabled) {
      actions.add("edit");
    }
    const deleteEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("deleteMessage"),
    );
    if (deleteEnabled) {
      actions.add("delete");
    }
    const stickerEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("stickers", false),
    );
    if (stickerEnabled) {
      actions.add("sticker");
      actions.add("sticker-search");
    }
    const groupManagementEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("groupManagement"),
    );
    if (groupManagementEnabled) {
      for (const action of SIGNAL_GROUP_MANAGEMENT_ACTIONS) {
        actions.add(action);
      }
    }
    return Array.from(actions);
  },
  supportsAction: ({ action }) =>
    action === "react" ||
    action === "edit" ||
    action === "delete" ||
    action === "unsend" ||
    action === "sticker" ||
    action === "sticker-search" ||
    SIGNAL_GROUP_MANAGEMENT_ACTIONS.includes(
      action as (typeof SIGNAL_GROUP_MANAGEMENT_ACTIONS)[number],
    ) ||
    (getSignalRuntime().channel.signal.messageActions?.supportsAction?.({ action }) ?? false),
  handleAction: async (ctx) => {
    if (ctx.action === "edit") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("editMessage")) {
        throw new Error("Signal edit is disabled via actions.editMessage.");
      }
      const recipient = readSignalRecipientParam(ctx.params);
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const content = readStringParam(ctx.params, "message", {
        required: true,
        allowEmpty: false,
      });
      const timestamp = parseSignalMessageTimestamp(messageId);
      await editMessageSignal({
        cfg: ctx.cfg,
        to: recipient,
        text: content,
        editTimestamp: timestamp,
        opts: { accountId: ctx.accountId ?? undefined },
      });
      return jsonResult({ ok: true, edited: true, messageId });
    }
    if (ctx.action === "delete" || ctx.action === "unsend") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("deleteMessage")) {
        throw new Error("Signal delete is disabled via actions.deleteMessage.");
      }
      const recipient = readSignalRecipientParam(ctx.params);
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const timestamp = parseSignalMessageTimestamp(messageId);
      await deleteMessageSignal({
        cfg: ctx.cfg,
        to: recipient,
        targetTimestamp: timestamp,
        opts: { accountId: ctx.accountId ?? undefined },
      });
      return jsonResult({ ok: true, deleted: true, messageId });
    }
    if (ctx.action === "sticker") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("stickers", false)) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const recipient = readSignalRecipientParam(ctx.params);
      const { packId, stickerId } = parseSignalStickerParams(ctx.params);
      const result = await sendStickerSignal({
        cfg: ctx.cfg,
        to: recipient,
        packId,
        stickerId,
        opts: { accountId: ctx.accountId ?? undefined },
      });
      return jsonResult({
        ok: true,
        messageId: result.messageId,
        timestamp: result.timestamp,
        packId,
        stickerId,
      });
    }
    if (ctx.action === "sticker-search") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("stickers", false)) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const query = readStringParam(ctx.params, "query");
      const limit = readNumberParam(ctx.params, "limit", { integer: true });
      const normalizedQuery = query?.trim().toLowerCase();
      const packs = await listStickerPacksSignal({
        cfg: ctx.cfg,
        opts: { accountId: ctx.accountId ?? undefined },
      });
      const filtered = normalizedQuery
        ? packs.filter((pack) => {
            const fields = [
              typeof pack.packId === "string" ? pack.packId : "",
              typeof pack.id === "string" ? pack.id : "",
              typeof pack.title === "string" ? pack.title : "",
              typeof pack.author === "string" ? pack.author : "",
            ]
              .join(" ")
              .toLowerCase();
            return fields.includes(normalizedQuery);
          })
        : packs;
      const capped =
        typeof limit === "number" && limit > 0 ? filtered.slice(0, Math.trunc(limit)) : filtered;
      return jsonResult({ ok: true, packs: capped });
    }
    if (ctx.action === "renameGroup") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const name = readStringParam(ctx.params, "name") ?? readStringParam(ctx.params, "displayName");
      if (!name?.trim()) {
        throw new Error("Signal renameGroup requires name parameter.");
      }
      await updateGroupSignal(
        groupId,
        { name: name.trim() },
        { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
      );
      return jsonResult({ ok: true, renamed: groupId, name: name.trim() });
    }
    if (ctx.action === "addParticipant") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const member =
        readStringParam(ctx.params, "participant") ??
        readStringParam(ctx.params, "member") ??
        readStringParam(ctx.params, "address");
      if (!member?.trim()) {
        throw new Error("Signal addParticipant requires participant parameter (phone number or UUID).");
      }
      await addGroupMemberSignal(groupId, member.trim(), {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, added: member.trim(), groupId });
    }
    if (ctx.action === "removeParticipant") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const member =
        readStringParam(ctx.params, "participant") ??
        readStringParam(ctx.params, "member") ??
        readStringParam(ctx.params, "address");
      if (!member?.trim()) {
        throw new Error(
          "Signal removeParticipant requires participant parameter (phone number or UUID).",
        );
      }
      await removeGroupMemberSignal(groupId, member.trim(), {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, removed: member.trim(), groupId });
    }
    if (ctx.action === "leaveGroup") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      await quitGroupSignal(groupId, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, left: groupId });
    }
    if (ctx.action === "member-info") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const members = await listGroupMembersSignal(groupId, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, groupId, members });
    }
    if (ctx.action === "react") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("reactions")) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }
      validateAndNormalizeReactionParams({
        args: ctx.params,
        toolContext: ctx.toolContext,
      });
      const recipientRaw = readSignalRecipientParam(ctx.params);
      const target = resolveSignalReactionTarget(recipientRaw);
      if (!target.recipient && !target.groupId) {
        throw new Error("recipient or group required");
      }
      const messageId = resolveReactionMessageId({
        args: ctx.params,
        toolContext: ctx.toolContext,
      });
      const timestamp = parseSignalMessageTimestamp(String(messageId ?? ""));
      const emoji = readStringParam(ctx.params, "emoji", {
        required: true,
        allowEmpty: false,
      });
      const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
      const targetAuthor = readStringParam(ctx.params, "targetAuthor");
      const targetAuthorUuid = readStringParam(ctx.params, "targetAuthorUuid");
      if (remove) {
        const result = await removeReactionSignal(target.recipient ?? "", timestamp, emoji, {
          cfg: ctx.cfg,
          accountId: ctx.accountId ?? undefined,
          groupId: target.groupId,
          targetAuthor: targetAuthor ?? undefined,
          targetAuthorUuid: targetAuthorUuid ?? undefined,
        });
        return jsonResult({ ok: true, removed: emoji, timestamp: result.timestamp });
      }
      const result = await sendReactionSignal(target.recipient ?? "", timestamp, emoji, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
        groupId: target.groupId,
        targetAuthor: targetAuthor ?? undefined,
        targetAuthorUuid: targetAuthorUuid ?? undefined,
      });
      return jsonResult({ ok: true, added: emoji, timestamp: result.timestamp });
    }
    const ma = getSignalRuntime().channel.signal.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Signal message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

const meta = SIGNAL_META;

type SenderScopedToolsEntry = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

type SignalSendOptsCompat = SignalSendOpts;

type SignalPayloadChannelData = {
  mentions?: unknown;
};

type SignalActionConfig = {
  reactions?: boolean;
  editMessage?: boolean;
  deleteMessage?: boolean;
  stickers?: boolean;
  groupManagement?: boolean;
};

const SIGNAL_GROUP_MANAGEMENT_ACTIONS = [
  "renameGroup",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "member-info",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createSignalActionGate(actions: SignalActionConfig | undefined) {
  return createActionGate<SignalActionConfig>(actions);
}

function normalizeSignalMentionRecipient(raw: string, index: number): string {
  const trimmed = stripSignalChannelPrefix(raw);
  if (!trimmed) {
    throw new Error(`Signal mention ${index} recipient is required`);
  }
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    const uuid = trimmed.slice("uuid:".length).trim();
    if (!uuid) {
      throw new Error(`Signal mention ${index} recipient is required`);
    }
    return uuid;
  }
  return trimmed;
}

function parseSignalMentionRanges(rawMentions: unknown): SignalMentionRange[] | undefined {
  if (!Array.isArray(rawMentions) || rawMentions.length === 0) {
    return undefined;
  }
  return rawMentions.map((rawMention, index) => {
    if (!isRecord(rawMention)) {
      throw new Error(`Signal mention ${index} must be an object`);
    }
    const start = Number(rawMention.start);
    if (!Number.isFinite(start) || start < 0) {
      throw new Error(`Signal mention ${index} has an invalid start`);
    }
    const length = Number(rawMention.length);
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error(`Signal mention ${index} has an invalid length`);
    }
    const recipientRaw = typeof rawMention.recipient === "string" ? rawMention.recipient : "";
    const recipient = normalizeSignalMentionRecipient(recipientRaw, index);
    return {
      start: Math.trunc(start),
      length: Math.trunc(length),
      recipient,
    };
  });
}

function resolveSignalPayloadMentions(payload: ReplyPayload): SignalMentionRange[] | undefined {
  if (!isRecord(payload.channelData)) {
    return undefined;
  }
  const signalData = payload.channelData[SIGNAL_CHANNEL_ID] ?? payload.channelData.signal;
  if (!isRecord(signalData)) {
    return undefined;
  }
  const typedSignalData = signalData as SignalPayloadChannelData;
  return parseSignalMentionRanges(typedSignalData.mentions);
}

function normalizeSignalReactionAuthor(raw: string): string {
  const trimmed = stripSignalChannelPrefix(raw);
  if (!trimmed) {
    return "";
  }
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    return trimmed.slice("uuid:".length).trim();
  }
  return trimmed;
}

function resolveSignalReactionTarget(raw: string): { recipient?: string; groupId?: string } {
  const trimmed = stripSignalChannelPrefix(raw);
  if (!trimmed) {
    return {};
  }
  if (trimmed.toLowerCase().startsWith("group:")) {
    const groupId = trimmed.slice("group:".length).trim();
    return groupId ? { groupId } : {};
  }
  const recipient = normalizeSignalReactionAuthor(trimmed);
  return recipient ? { recipient } : {};
}

function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}): string | number | undefined {
  const direct = params.args.messageId;
  if (typeof direct === "string" || typeof direct === "number") {
    return direct;
  }
  return params.toolContext?.currentMessageId;
}

function validateAndNormalizeReactionParams(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}) {
  const targetAuthorRaw =
    typeof params.args.targetAuthor === "string" ? params.args.targetAuthor : "";
  const targetAuthorUuidRaw =
    typeof params.args.targetAuthorUuid === "string" ? params.args.targetAuthorUuid : "";
  const targetAuthor = normalizeSignalReactionAuthor(targetAuthorRaw);
  const targetAuthorUuid = normalizeSignalReactionAuthor(targetAuthorUuidRaw);
  if (!targetAuthor && !targetAuthorUuid) {
    throw new Error("targetAuthor or targetAuthorUuid required for Signal reactions.");
  }
  if (targetAuthor) {
    params.args.targetAuthor = targetAuthor;
  }
  if (targetAuthorUuid) {
    params.args.targetAuthorUuid = targetAuthorUuid;
  }

  const messageId = resolveReactionMessageId(params);
  if (messageId != null) {
    const timestamp = Number.parseInt(String(messageId), 10);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid messageId: ${String(messageId)}. Expected numeric timestamp.`);
    }
    params.args.messageId = String(timestamp);
  }

  const emoji = typeof params.args.emoji === "string" ? params.args.emoji.trim() : "";
  if (!emoji) {
    throw new Error("Emoji required for Signal reactions.");
  }
  params.args.emoji = emoji;
}

function readSignalRecipientParam(params: Record<string, unknown>): string {
  return (
    readStringParam(params, "recipient") ??
    readStringParam(params, "to", {
      required: true,
      label: "recipient (phone number, UUID, or group)",
    })
  );
}

function readSignalGroupIdParam(params: Record<string, unknown>): string {
  const raw =
    readStringParam(params, "groupId") ??
    readStringParam(params, "to", {
      required: true,
      label: "groupId (Signal group ID)",
    });
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Signal group management requires groupId.");
  }
  return stripSignalChannelPrefix(trimmed).replace(/^group:/i, "").trim();
}

function parseSignalMessageTimestamp(raw: string): number {
  const timestamp = Number.parseInt(raw, 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid messageId: ${raw}. Expected numeric timestamp.`);
  }
  return timestamp;
}

function parseSignalStickerParams(params: Record<string, unknown>): {
  packId: string;
  stickerId: number;
} {
  const stickerIds = readStringArrayParamLoose(params, "stickerId");
  const packIdParam = readStringParam(params, "packId");
  const stickerIdParam = readNumberParam(params, "stickerNum", {
    integer: true,
  });
  const firstSticker = stickerIds?.[0]?.trim();
  if (firstSticker?.includes(":")) {
    const [packIdRaw, stickerIdRaw] = firstSticker.split(":", 2);
    const packId = packIdRaw?.trim();
    const stickerId = Number.parseInt(stickerIdRaw?.trim() ?? "", 10);
    if (!packId || !Number.isFinite(stickerId) || stickerId < 0) {
      throw new Error("Signal stickerId must be in packId:stickerId format.");
    }
    return { packId, stickerId };
  }
  const packId = packIdParam?.trim();
  if (!packId) {
    throw new Error("Signal sticker requires packId or stickerId=packId:stickerId.");
  }
  const stickerId =
    stickerIdParam ??
    (() => {
      if (!firstSticker) {
        return Number.NaN;
      }
      return Number.parseInt(firstSticker, 10);
    })();
  if (!Number.isFinite(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker requires a non-negative sticker ID.");
  }
  return {
    packId,
    stickerId: Math.trunc(stickerId),
  };
}

function readStringArrayParamLoose(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  return undefined;
}

function resolveSenderScopedToolPolicy(
  entry: SenderScopedToolsEntry | undefined,
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  if (!entry) {
    return undefined;
  }
  const bySender = entry.toolsBySender;
  if (!bySender || Object.keys(bySender).length === 0) {
    return entry.tools;
  }
  const candidates: string[] = [];
  const push = (value?: string | null) => {
    const trimmed = value?.trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  };
  push(params.senderId);
  push(params.senderE164);
  push(params.senderUsername);
  push(params.senderName);
  if (params.senderId) {
    candidates.push(`id:${params.senderId}`);
  }
  if (params.senderE164) {
    candidates.push(`e164:${params.senderE164}`);
  }
  if (params.senderUsername) {
    candidates.push(`username:${params.senderUsername}`);
  }
  if (params.senderName) {
    candidates.push(`name:${params.senderName}`);
  }
  for (const key of candidates) {
    const hit = bySender[key];
    if (hit) {
      return hit;
    }
  }
  return bySender["*"] ?? entry.tools;
}

function clampDirectoryLimit(limit?: number | null): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  return Math.trunc(limit);
}

function applyDirectoryQueryAndLimit<T extends { id: string; name?: string }>(
  entries: T[],
  query?: string | null,
  limit?: number | null,
): T[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const filtered = normalizedQuery
    ? entries.filter((entry) => {
        const id = entry.id.toLowerCase();
        const name = entry.name?.toLowerCase() ?? "";
        return id.includes(normalizedQuery) || name.includes(normalizedQuery);
      })
    : entries;
  const clamped = clampDirectoryLimit(limit);
  return clamped ? filtered.slice(0, clamped) : filtered;
}

function normalizeDirectoryGroupId(raw: string): string {
  return raw.replace(/^group:/i, "").trim();
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

type SignalSendFn = (
  to: string,
  text: string,
  opts: SignalSendOptsCompat,
) => Promise<SignalSendResult>;

async function sendSignalOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  silent?: boolean;
  mentions?: SignalMentionRange[];
  textMode?: SignalSendOpts["textMode"];
  textStyles?: SignalTextStyleRange[];
  deps?: { sendSignal?: SignalSendFn };
}) {
  const send = params.deps?.sendSignal ?? sendMessageSignal;
  const channelConfig = getSignalConfig(params.cfg);
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      channelConfig?.accounts?.[accountId]?.mediaMaxMb ?? channelConfig?.mediaMaxMb,
    accountId: params.accountId,
  });
  const sendOpts: SignalSendOptsCompat = {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    ...(params.textMode ? { textMode: params.textMode } : {}),
    ...(params.textStyles?.length ? { textStyles: params.textStyles } : {}),
  };
  if (params.silent) {
    sendOpts.silent = true;
  }
  if (params.mentions?.length) {
    sendOpts.mentions = params.mentions;
  }
  return await send(params.to, params.text, sendOpts);
}

async function sendSignalPayloadOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  silent?: boolean;
  deps?: { sendSignal?: SignalSendFn };
}) {
  const text = params.payload.text ?? "";
  const mediaUrls = params.payload.mediaUrls?.length
    ? params.payload.mediaUrls
    : params.payload.mediaUrl
      ? [params.payload.mediaUrl]
      : [];
  const mentions = resolveSignalPayloadMentions(params.payload);

  if (!text && mediaUrls.length === 0) {
    return { channel: SIGNAL_CHANNEL_ID, messageId: "" };
  }

  if (mediaUrls.length > 0) {
    let lastResult = await sendSignalOutbound({
      cfg: params.cfg,
      to: params.to,
      text,
      mediaUrl: mediaUrls[0],
      mediaLocalRoots: params.mediaLocalRoots,
      accountId: params.accountId,
      silent: params.silent,
      mentions,
      deps: params.deps,
    });
    for (let i = 1; i < mediaUrls.length; i += 1) {
      lastResult = await sendSignalOutbound({
        cfg: params.cfg,
        to: params.to,
        text: "",
        mediaUrl: mediaUrls[i],
        mediaLocalRoots: params.mediaLocalRoots,
        accountId: params.accountId,
        silent: params.silent,
        deps: params.deps,
      });
    }
    return { channel: SIGNAL_CHANNEL_ID, ...lastResult };
  }

  const chunkLimit = 4000;
  if (mentions?.length) {
    // Mention offsets are authored against the final payload text, so keep the
    // message intact instead of re-chunking and invalidating native ranges.
    const result = await sendSignalOutbound({
      cfg: params.cfg,
      to: params.to,
      text,
      accountId: params.accountId,
      silent: params.silent,
      mentions,
      deps: params.deps,
    });
    return { channel: SIGNAL_CHANNEL_ID, ...result };
  }
  const tableMode = getSignalRuntime().channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: SIGNAL_CHANNEL_ID,
    accountId: params.accountId ?? undefined,
  });
  const chunks = markdownToSignalTextChunks(text, chunkLimit, { tableMode });
  let lastResult = { messageId: "" };
  for (const chunk of chunks) {
    lastResult = await sendSignalOutbound({
      cfg: params.cfg,
      to: params.to,
      text: chunk.text,
      textMode: "plain",
      textStyles: chunk.styles,
      accountId: params.accountId,
      silent: params.silent,
      deps: params.deps,
    });
  }
  return { channel: SIGNAL_CHANNEL_ID, ...lastResult };
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: SIGNAL_CHANNEL_ID,
  meta: {
    ...meta,
  },
  onboarding: signalOnboardingAdapter,
  pairing: {
    idLabel: "signalNumber",
    normalizeAllowEntry: (entry) => stripSignalChannelPrefix(entry),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageSignal(id, PAIRING_APPROVED_MESSAGE, { cfg });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    groupManagement: true,
    blockStreaming: true,
  },
  actions: signalMessageActions,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  mentions: {
    stripPatterns: () => ["\uFFFC"],
  },
  reload: { configPrefixes: [`channels.${SIGNAL_CHANNEL_ID}`] },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: SIGNAL_CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: SIGNAL_CHANNEL_ID,
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : normalizeE164(stripSignalChannelPrefix(entry))))
        .filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(getSignalConfig(cfg)?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.${SIGNAL_CHANNEL_ID}.accounts.${resolvedAccountId}.`
        : `channels.${SIGNAL_CHANNEL_ID}.`;
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint(SIGNAL_CHANNEL_ID),
        normalizeEntry: (raw) => normalizeE164(stripSignalChannelPrefix(raw)),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: getSignalConfig(cfg) !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Signal groups: groupPolicy="open" allows any member to trigger the bot. Set channels.${SIGNAL_CHANNEL_ID}.groupPolicy="allowlist" + channels.${SIGNAL_CHANNEL_ID}.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: (params) =>
      getSignalRuntime().channel.groups.resolveRequireMention({
        cfg: params.cfg,
        channel: SIGNAL_CHANNEL_ID,
        groupId: params.groupId,
        accountId: params.accountId ?? undefined,
      }),
    resolveToolPolicy: (params) => {
      const policy = getSignalRuntime().channel.groups.resolveGroupPolicy({
        cfg: params.cfg,
        channel: SIGNAL_CHANNEL_ID,
        groupId: params.groupId,
        accountId: params.accountId ?? undefined,
      });
      const scopedPolicy = resolveSenderScopedToolPolicy(policy.groupConfig, params);
      if (scopedPolicy) {
        return scopedPolicy;
      }
      return resolveSenderScopedToolPolicy(policy.defaultConfig, params);
    },
  },
  messaging: {
    normalizeTarget: normalizeSignalCustomMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSignalCustomTargetId,
      hint: "<E.164|uuid:ID|group:ID|signal-custom:group:ID|signal-custom:+E.164>",
    },
  },
  directory: {
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const contacts = await listSignalContacts({
        cfg,
        accountId: accountId ?? undefined,
      });
      const entries = contacts
        .map((contact) => {
          const number = typeof contact.number === "string" ? normalizeE164(contact.number) : "";
          const uuid = typeof contact.uuid === "string" ? contact.uuid.trim() : "";
          const id = number || (uuid ? `uuid:${uuid}` : "");
          if (!id) {
            return null;
          }
          const name = typeof contact.name === "string" ? contact.name.trim() : "";
          return {
            kind: "user" as const,
            id,
            ...(name ? { name } : {}),
            raw: contact,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, query, limit);
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const groups = await listSignalGroups(
        {
          cfg,
          accountId: accountId ?? undefined,
        },
        { detailed: false },
      );
      const entries = groups
        .map((group) => {
          const groupId = typeof group.id === "string" ? group.id.trim() : "";
          if (!groupId) {
            return null;
          }
          const name = typeof group.name === "string" ? group.name.trim() : "";
          return {
            kind: "group" as const,
            id: `group:${groupId}`,
            ...(name ? { name } : {}),
            raw: group,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, query, limit);
    },
    listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
      const members = await listGroupMembersSignal(normalizeDirectoryGroupId(groupId), {
        cfg,
        accountId: accountId ?? undefined,
      });
      const entries = members
        .map((member) => {
          const number = typeof member.number === "string" ? normalizeE164(member.number) : "";
          const uuid = typeof member.uuid === "string" ? member.uuid.trim() : "";
          const id = number || (uuid ? `uuid:${uuid}` : "");
          if (!id) {
            return null;
          }
          const name = typeof member.name === "string" ? member.name.trim() : "";
          return {
            kind: "user" as const,
            id,
            ...(name ? { name } : {}),
            raw: member,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, undefined, limit);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: SIGNAL_CHANNEL_ID,
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: SIGNAL_CHANNEL_ID,
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: SIGNAL_CHANNEL_ID,
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            [SIGNAL_CHANNEL_ID]: {
              ...next.channels?.[SIGNAL_CHANNEL_ID],
              enabled: true,
              ...buildSignalSetupPatch(input),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          [SIGNAL_CHANNEL_ID]: {
            ...next.channels?.[SIGNAL_CHANNEL_ID],
            enabled: true,
            accounts: {
              ...getSignalConfig(next)?.accounts,
              [accountId]: {
                ...getSignalConfig(next)?.accounts?.[accountId],
                enabled: true,
                ...buildSignalSetupPatch(input),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => chunkTextForOutbound(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendPayload: async ({ cfg, to, payload, mediaLocalRoots, accountId, deps, silent }) => {
      return await sendSignalPayloadOutbound({
        cfg,
        to,
        payload,
        mediaLocalRoots,
        accountId: accountId ?? undefined,
        deps,
        silent: silent ?? undefined,
      });
    },
    sendText: async ({ cfg, to, text, accountId, deps, silent }) => {
      const result = await sendSignalOutbound({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        deps,
      });
      return { channel: SIGNAL_CHANNEL_ID, ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, silent }) => {
      const result = await sendSignalOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        deps,
      });
      return { channel: SIGNAL_CHANNEL_ID, ...result };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError(SIGNAL_CHANNEL_ID, accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      baseUrl: account.baseUrl,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      return getSignalRuntime().channel.signal.monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};
