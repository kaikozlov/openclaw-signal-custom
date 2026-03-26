import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createChatChannelPlugin,
  collectStatusIssuesFromLastError,
  createActionGate,
  jsonResult,
  normalizeE164,
  PAIRING_APPROVED_MESSAGE,
  readNumberParam,
  readStringParam,
  resolveReactionMessageId,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
  type ChannelGroupContext,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
} from "./runtime-api.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID, stripSignalChannelPrefix } from "./constants.js";
import { getSignalRuntime } from "./runtime.js";
import { createSignalCustomPluginBase } from "./shared.js";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  sendStickerSignal,
} from "./signal/send-actions.js";
import {
  sendMessageSignal,
  sendPollCreateSignal,
} from "./signal/send.js";
import {
  resolveSignalReactionTarget as resolveCachedSignalReactionTarget,
} from "./signal/reaction-target-cache.js";
import { removeReactionSignal, sendReactionSignal } from "./signal/send-reactions.js";
import { listSignalContacts, listSignalGroups } from "./signal/directory.js";
import {
  addGroupMemberSignal,
  addGroupAdminSignal,
  banGroupMemberSignal,
  getGroupInfoSignal,
  listGroupMembersSignal,
  quitGroupSignal,
  removeGroupAdminSignal,
  removeGroupMemberSignal,
  unbanGroupMemberSignal,
  updateGroupSignal,
} from "./signal/groups.js";
import {
  inferSignalCustomTargetChatType,
  looksLikeSignalCustomTargetId,
  normalizeSignalCustomMessagingTarget,
  parseSignalCustomExplicitTarget,
  resolveSignalCustomOutboundSessionRoute,
} from "./targets.js";
import { type SignalProbe } from "./signal/probe.js";
import { signalOutboundBase } from "./outbound.js";

type ReactionToolContext = {
  currentMessageId?: string | number;
};

const SIGNAL_GROUP_MANAGEMENT_ACTIONS = [
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "role-add",
  "role-remove",
  "ban",
  "channel-edit",
  "permissions",
  "leaveGroup",
  "member-info",
  "channel-info",
] as const;

const SIGNAL_LOCAL_MESSAGE_ACTIONS = [
  "react",
  "edit",
  "delete",
  "unsend",
  "sticker",
  "sticker-search",
  ...SIGNAL_GROUP_MANAGEMENT_ACTIONS,
] as const satisfies readonly ChannelMessageActionName[];

const signalMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }: { cfg: Parameters<typeof listSignalAccountIds>[0] }) => {
    const configuredAccounts = listSignalAccountIds(cfg)
      .map((accountId) => resolveSignalAccount({ cfg, accountId }))
      .filter((account) => account.enabled && account.configured);
    if (configuredAccounts.length === 0) {
      return null;
    }
    const actions = new Set<ChannelMessageActionName>(["send"]);
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
    const unsendEnabled = configuredAccounts.some((account) =>
      createSignalActionGate(account.config.actions)("unsend"),
    );
    if (unsendEnabled) {
      actions.add("unsend");
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
    return { actions: Array.from(actions) };
  },
  supportsAction: ({ action }) =>
    SIGNAL_LOCAL_MESSAGE_ACTIONS.includes(
      action as (typeof SIGNAL_LOCAL_MESSAGE_ACTIONS)[number],
    ),
  handleAction: async (ctx) => {
    const action = String(ctx.action);
    if (action === "edit") {
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
    if (action === "delete" || action === "unsend") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (action === "unsend") {
        if (!createSignalActionGate(actionConfig)("unsend")) {
          throw new Error("Signal unsend is disabled via actions.unsend.");
        }
      } else if (!createSignalActionGate(actionConfig)("deleteMessage")) {
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
    if (action === "sticker") {
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
    if (action === "sticker-search") {
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
    if (action === "renameGroup") {
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
    if (action === "channel-edit") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const description = readStringParam(ctx.params, "description");
      if (description?.trim()) {
        await updateGroupSignal(
          groupId,
          { description: description.trim() },
          { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
        );
        return jsonResult({ ok: true, groupId, description: description.trim() });
      }
      const linkInput =
        readStringParam(ctx.params, "linkState") ??
        readStringParam(ctx.params, "state") ??
        readStringParam(ctx.params, "link");
      if (linkInput?.trim()) {
        const link = normalizeSignalGroupLinkState(linkInput);
        await updateGroupSignal(
          groupId,
          { link },
          { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
        );
        return jsonResult({ ok: true, groupId, link });
      }
      const shouldResetLink =
        typeof ctx.params.resetLink === "boolean"
          ? ctx.params.resetLink
          : typeof ctx.params.resetLink === "string"
            ? ["true", "1", "yes", "on"].includes(ctx.params.resetLink.trim().toLowerCase())
            : false;
      if (shouldResetLink) {
        await updateGroupSignal(
          groupId,
          { resetLink: true },
          { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
        );
        return jsonResult({ ok: true, groupId, resetLink: true });
      }
      const expiration =
        readNumberParam(ctx.params, "expiration", { integer: true }) ??
        readNumberParam(ctx.params, "seconds", { integer: true });
      if (typeof expiration === "number") {
        if (!Number.isFinite(expiration) || expiration < 0) {
          throw new Error("Signal channel-edit expiration must be a non-negative integer.");
        }
        const normalizedExpiration = Math.trunc(expiration);
        await updateGroupSignal(
          groupId,
          { expiration: normalizedExpiration },
          { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
        );
        return jsonResult({ ok: true, groupId, expiration: normalizedExpiration });
      }
      throw new Error(
        "Signal channel-edit requires one of: description, linkState/state/link, resetLink=true, or expiration/seconds.",
      );
    }
    if (action === "setGroupIcon") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const { avatarPath, cleanup } = await resolveSignalGroupIconSource(ctx.params);
      try {
        await updateGroupSignal(
          groupId,
          { avatar: avatarPath },
          { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
        );
      } finally {
        await cleanup?.();
      }
      return jsonResult({ ok: true, groupId, avatar: avatarPath });
    }
    if (action === "addParticipant") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const member = readSignalParticipantParam(ctx.params, "addParticipant");
      await addGroupMemberSignal(groupId, member, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, added: member, groupId });
    }
    if (action === "removeParticipant") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const member = readSignalParticipantParam(ctx.params, "removeParticipant");
      await removeGroupMemberSignal(groupId, member, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, removed: member, groupId });
    }
    if (action === "role-add") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const role = readSignalAdminRoleParam(ctx.params);
      const member = readSignalParticipantParam(ctx.params, "role-add");
      await addGroupAdminSignal(groupId, member, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, promoted: member, groupId, role });
    }
    if (action === "role-remove") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const role = readSignalAdminRoleParam(ctx.params);
      const member = readSignalParticipantParam(ctx.params, "role-remove");
      await removeGroupAdminSignal(groupId, member, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, demoted: member, groupId, role });
    }
    if (action === "ban") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const member = readSignalParticipantParam(
        ctx.params,
        typeof ctx.params.unban === "boolean" && ctx.params.unban ? "unban" : "ban",
      );
      const shouldUnban =
        (typeof ctx.params.unban === "boolean" && ctx.params.unban) ||
        (typeof ctx.params.remove === "boolean" && ctx.params.remove) ||
        (typeof ctx.params.mode === "string" && ctx.params.mode.trim().toLowerCase() === "unban");
      if (shouldUnban) {
        await unbanGroupMemberSignal(groupId, member, {
          cfg: ctx.cfg,
          accountId: ctx.accountId ?? undefined,
        });
        return jsonResult({ ok: true, unbanned: member, groupId });
      }
      await banGroupMemberSignal(groupId, member, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, banned: member, groupId });
    }
    if (action === "permissions") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const permissionSetting =
        readStringParam(ctx.params, "setting") ??
        readStringParam(ctx.params, "permissionType") ??
        readStringParam(ctx.params, "scope");
      if (permissionSetting?.trim()) {
        const normalizedSetting = permissionSetting.trim().toLowerCase();
        const permission = readSignalGroupPermissionParam(ctx.params);
        if (normalizedSetting === "add-member" || normalizedSetting === "addmember") {
          await updateGroupSignal(
            groupId,
            { permissionAddMember: permission },
            { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
          );
          return jsonResult({ ok: true, groupId, setting: "add-member", permission });
        }
        if (normalizedSetting === "edit-details" || normalizedSetting === "editdetails") {
          await updateGroupSignal(
            groupId,
            { permissionEditDetails: permission },
            { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
          );
          return jsonResult({ ok: true, groupId, setting: "edit-details", permission });
        }
        if (
          normalizedSetting === "send-messages" ||
          normalizedSetting === "sendmessages" ||
          normalizedSetting === "announcements"
        ) {
          await updateGroupSignal(
            groupId,
            { permissionSendMessages: permission },
            { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
          );
          return jsonResult({
            ok: true,
            groupId,
            setting: normalizedSetting === "announcements" ? "announcements" : "send-messages",
            permission,
            ...(normalizedSetting === "announcements"
              ? { announcements: permission === "onlyAdmins" }
              : {}),
          });
        }
        throw new Error(
          'Signal permissions setting must be "add-member", "edit-details", "send-messages", or "announcements".',
        );
      }
      const enabled = readSignalBooleanParam(
        ctx.params,
        ["enabled", "announcement", "announcementMode", "value"],
        "permissions",
      );
      const permission = enabled ? "onlyAdmins" : "everyMember";
      await updateGroupSignal(
        groupId,
        { permissionSendMessages: permission },
        { cfg: ctx.cfg, accountId: ctx.accountId ?? undefined },
      );
      return jsonResult({ ok: true, groupId, setting: "announcements", announcements: enabled, permission });
    }
    if (action === "leaveGroup") {
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
    if (action === "channel-info") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const group = await getGroupInfoSignal(groupId, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      return jsonResult({ ok: true, groupId, group });
    }
    if (action === "member-info") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("groupManagement")) {
        throw new Error("Signal group management is disabled via actions.groupManagement.");
      }
      const groupId = readSignalGroupIdParam(ctx.params);
      const members = await listGroupMembersSignal(groupId, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
      });
      const memberId =
        readStringParam(ctx.params, "memberId") ??
        readStringParam(ctx.params, "userId") ??
        readStringParam(ctx.params, "participant") ??
        readStringParam(ctx.params, "member") ??
        readStringParam(ctx.params, "address");
      if (!memberId?.trim()) {
        return jsonResult({ ok: true, groupId, members });
      }
      const normalizedMemberId = stripSignalChannelPrefix(memberId.trim()).replace(/^uuid:/i, "").trim();
      const member =
        members.find((entry) => {
          const number = typeof entry.number === "string" ? stripSignalChannelPrefix(entry.number).trim() : "";
          const uuid = typeof entry.uuid === "string" ? stripSignalChannelPrefix(entry.uuid).replace(/^uuid:/i, "").trim() : "";
          return number === normalizedMemberId || uuid === normalizedMemberId;
        }) ?? null;
      return jsonResult({ ok: true, groupId, memberId: normalizedMemberId, member });
    }
    if (action === "react") {
      const actionConfig = resolveSignalAccount({ cfg: ctx.cfg, accountId: ctx.accountId }).config.actions;
      if (!createSignalActionGate(actionConfig)("reactions")) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }
      normalizeReactionMessageIdAndEmoji({
        args: ctx.params,
        toolContext: ctx.toolContext,
      });
      const recipientRaw = readSignalRecipientParam(ctx.params);
      const target = resolveSignalReactionDestination(recipientRaw);
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
      const reactionAuthor = resolveReactionTargetAuthor({
        args: ctx.params,
        recipientRaw,
        messageId: String(messageId),
      });
      if (remove) {
        const result = await removeReactionSignal(target.recipient ?? "", timestamp, emoji, {
          cfg: ctx.cfg,
          accountId: ctx.accountId ?? undefined,
          groupId: target.groupId,
          targetAuthor: reactionAuthor.targetAuthor,
          targetAuthorUuid: reactionAuthor.targetAuthorUuid,
        });
        return jsonResult({ ok: true, removed: emoji, timestamp: result.timestamp });
      }
      const result = await sendReactionSignal(target.recipient ?? "", timestamp, emoji, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
        groupId: target.groupId,
        targetAuthor: reactionAuthor.targetAuthor,
        targetAuthorUuid: reactionAuthor.targetAuthorUuid,
      });
      return jsonResult({ ok: true, added: emoji, timestamp: result.timestamp });
    }
    throw new Error(`Action ${action} not supported for ${SIGNAL_CHANNEL_ID}.`);
  },
};

type SenderScopedToolsEntry = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

type SignalActionConfig = {
  reactions?: boolean;
  unsend?: boolean;
  poll?: boolean;
  editMessage?: boolean;
  deleteMessage?: boolean;
  stickers?: boolean;
  groupManagement?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createSignalActionGate(actions: SignalActionConfig | undefined) {
  return createActionGate<SignalActionConfig>(actions);
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

function resolveSignalReactionDestination(raw: string): { recipient?: string; groupId?: string } {
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

function normalizeReactionMessageIdAndEmoji(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}) {
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

function resolveReactionTargetAuthor(params: {
  args: Record<string, unknown>;
  recipientRaw: string;
  messageId: string;
}): { targetAuthor?: string; targetAuthorUuid?: string } {
  const targetAuthorRaw =
    typeof params.args.targetAuthor === "string" ? params.args.targetAuthor : "";
  const targetAuthorUuidRaw =
    typeof params.args.targetAuthorUuid === "string" ? params.args.targetAuthorUuid : "";
  const targetAuthor = normalizeSignalReactionAuthor(targetAuthorRaw);
  const targetAuthorUuid = normalizeSignalReactionAuthor(targetAuthorUuidRaw);
  if (targetAuthor) {
    params.args.targetAuthor = targetAuthor;
  }
  if (targetAuthorUuid) {
    params.args.targetAuthorUuid = targetAuthorUuid;
  }
  if (targetAuthor || targetAuthorUuid) {
    return {
      targetAuthor: targetAuthor || undefined,
      targetAuthorUuid: targetAuthorUuid || undefined,
    };
  }

  const destination = resolveSignalReactionDestination(params.recipientRaw);
  const cachedTarget = resolveCachedSignalReactionTarget({
    groupId: destination.groupId,
    recipient: destination.groupId ? undefined : destination.recipient,
    messageId: params.messageId,
  });
  if (cachedTarget?.targetAuthorUuid) {
    params.args.targetAuthorUuid = cachedTarget.targetAuthorUuid;
    return { targetAuthorUuid: cachedTarget.targetAuthorUuid };
  }
  if (cachedTarget?.targetAuthor) {
    params.args.targetAuthor = cachedTarget.targetAuthor;
    return { targetAuthor: cachedTarget.targetAuthor };
  }
  if (destination.recipient) {
    params.args.targetAuthor = destination.recipient;
    return { targetAuthor: destination.recipient };
  }

  throw new Error("targetAuthor or targetAuthorUuid required for Signal reactions.");
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
    readStringParam(params, "channelId") ??
    readStringParam(params, "chatId") ??
    readStringParam(params, "chatGuid") ??
    readStringParam(params, "chatIdentifier") ??
    readStringParam(params, "to", {
      required: true,
      label: "groupId/channelId (Signal group ID)",
    });
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Signal group management requires groupId.");
  }
  return stripSignalChannelPrefix(trimmed).replace(/^(group|channel):/i, "").trim();
}

function readSignalParticipantParam(params: Record<string, unknown>, label: string): string {
  const value =
    readStringParam(params, "userId") ??
    readStringParam(params, "memberId") ??
    readStringParam(params, "participant") ??
    readStringParam(params, "member") ??
    readStringParam(params, "address");
  if (!value?.trim()) {
    throw new Error(`Signal ${label} requires participant parameter (phone number or UUID).`);
  }
  return value.trim();
}

function normalizeSignalGroupPermission(raw: string): "everyMember" | "onlyAdmins" {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "every-member":
    case "everymember":
      return "everyMember";
    case "only-admins":
    case "onlyadmins":
      return "onlyAdmins";
    default:
      throw new Error('Signal group permission must be "every-member" or "only-admins".');
  }
}

function readSignalGroupPermissionParam(params: Record<string, unknown>): "everyMember" | "onlyAdmins" {
  const raw =
    readStringParam(params, "permission") ??
    readStringParam(params, "value") ??
    readStringParam(params, "mode", {
      required: true,
      label: 'permission ("every-member" or "only-admins")',
    });
  return normalizeSignalGroupPermission(raw);
}

function normalizeSignalAdminRole(raw: string | undefined): "admin" {
  if (!raw?.trim()) {
    return "admin";
  }
  const value = raw.trim().toLowerCase();
  if (["admin", "admins", "administrator", "administrators", "group-admin"].includes(value)) {
    return "admin";
  }
  throw new Error('Signal only supports the "admin" group role.');
}

function readSignalAdminRoleParam(params: Record<string, unknown>): "admin" {
  return normalizeSignalAdminRole(
    readStringParam(params, "roleId") ??
      readStringParam(params, "role") ??
      readStringParam(params, "name"),
  );
}

function normalizeSignalGroupLinkState(raw: string): "enabled" | "enabledWithApproval" | "disabled" {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "enabled":
      return "enabled";
    case "enabled-with-approval":
    case "enabledwithapproval":
      return "enabledWithApproval";
    case "disabled":
      return "disabled";
    default:
      throw new Error(
        'Signal group link state must be "enabled", "enabled-with-approval", or "disabled".',
      );
  }
}

function readSignalGroupLinkStateParam(
  params: Record<string, unknown>,
): "enabled" | "enabledWithApproval" | "disabled" {
  const raw =
    readStringParam(params, "linkState") ??
    readStringParam(params, "state") ??
    readStringParam(params, "value", {
      required: true,
      label: 'link state ("enabled", "enabled-with-approval", or "disabled")',
    });
  return normalizeSignalGroupLinkState(raw);
}

function readSignalBooleanParam(
  params: Record<string, unknown>,
  keys: string[],
  label: string,
): boolean {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "on", "1", "enabled"].includes(normalized)) {
        return true;
      }
      if (["false", "no", "off", "0", "disabled"].includes(normalized)) {
        return false;
      }
    }
  }
  throw new Error(`Signal ${label} requires a boolean value.`);
}

function extensionForSignalContentType(contentType?: string): string {
  switch (contentType?.trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/heic":
      return ".heic";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    case "image/png":
    default:
      return ".png";
  }
}

async function resolveSignalGroupIconSource(params: Record<string, unknown>): Promise<{
  avatarPath: string;
  cleanup?: () => Promise<void>;
}> {
  const rawBuffer = readStringParam(params, "buffer", { trim: false });
  if (rawBuffer) {
    const filename =
      readStringParam(params, "filename", { trim: false }) ??
      readStringParam(params, "name", { trim: false }) ??
      `group-icon${extensionForSignalContentType(readStringParam(params, "contentType") ?? readStringParam(params, "mimeType"))}`;
    const safeName = path.basename(filename.trim() || "group-icon.png");
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-signal-group-icon-"));
    const avatarPath = path.join(dir, safeName);
    await writeFile(avatarPath, Buffer.from(rawBuffer, "base64"));
    return {
      avatarPath,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
  const avatar =
    readStringParam(params, "avatar") ??
    readStringParam(params, "media", { trim: false }) ??
    readStringParam(params, "path", { trim: false }) ??
    readStringParam(params, "file", { trim: false }) ??
    readStringParam(params, "filePath", { trim: false }) ??
    readStringParam(params, "mediaUrl", { trim: false }) ??
    readStringParam(params, "fileUrl", {
      required: true,
      allowEmpty: false,
      trim: false,
      label: "group icon media",
    });
  return { avatarPath: avatar.trim() };
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

function normalizeSignalResolverInput(raw: string): {
  raw: string;
  lower: string;
  e164: string;
  uuid: string;
  groupId: string;
} {
  const trimmed = stripSignalChannelPrefix(raw);
  const lower = trimmed.toLowerCase();
  const e164 = normalizeE164(trimmed);
  const uuid = lower.startsWith("uuid:") ? trimmed.slice("uuid:".length).trim().toLowerCase() : "";
  const groupId = lower.startsWith("group:") ? trimmed.slice("group:".length).trim() : trimmed;
  return { raw: trimmed, lower, e164, uuid, groupId };
}

function resolveSignalContactTarget(params: {
  contacts: Awaited<ReturnType<typeof listSignalContacts>>;
  input: string;
}) {
  const normalized = normalizeSignalResolverInput(params.input);
  const toResolved = (contact: Awaited<ReturnType<typeof listSignalContacts>>[number]) => {
    const number = typeof contact.number === "string" ? normalizeE164(contact.number) : "";
    const uuid = typeof contact.uuid === "string" ? contact.uuid.trim().toLowerCase() : "";
    const name = typeof contact.name === "string" ? contact.name.trim() : "";
    const id = number || (uuid ? `uuid:${uuid}` : "");
    return {
      input: params.input,
      resolved: Boolean(id),
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
    };
  };
  const exactIdMatches = params.contacts.filter((contact) => {
    const number = typeof contact.number === "string" ? normalizeE164(contact.number) : "";
    const uuid = typeof contact.uuid === "string" ? contact.uuid.trim().toLowerCase() : "";
    return Boolean((normalized.e164 && number === normalized.e164) || (normalized.uuid && uuid === normalized.uuid));
  });
  if (exactIdMatches.length === 1) {
    return toResolved(exactIdMatches[0]!);
  }
  if (exactIdMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous contact match" };
  }

  const exactNameMatches = params.contacts.filter((contact) => {
    const name = typeof contact.name === "string" ? contact.name.trim().toLowerCase() : "";
    return Boolean(normalized.lower && name === normalized.lower);
  });
  if (exactNameMatches.length === 1) {
    return toResolved(exactNameMatches[0]!);
  }
  if (exactNameMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous contact match" };
  }

  const partialNameMatches = params.contacts.filter((contact) => {
    const name = typeof contact.name === "string" ? contact.name.trim().toLowerCase() : "";
    return Boolean(normalized.lower && name.includes(normalized.lower));
  });
  if (partialNameMatches.length === 1) {
    return toResolved(partialNameMatches[0]!);
  }
  if (partialNameMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous contact match" };
  }

  return { input: params.input, resolved: false, note: "no matching Signal contact" };
}

function resolveSignalGroupTarget(params: {
  groups: Awaited<ReturnType<typeof listSignalGroups>>;
  input: string;
}) {
  const normalized = normalizeSignalResolverInput(params.input);
  const toResolved = (group: Awaited<ReturnType<typeof listSignalGroups>>[number]) => {
    const groupId = typeof group.id === "string" ? group.id.trim() : "";
    const name = typeof group.name === "string" ? group.name.trim() : "";
    return {
      input: params.input,
      resolved: Boolean(groupId),
      ...(groupId ? { id: `group:${groupId}` } : {}),
      ...(name ? { name } : {}),
    };
  };
  const exactIdMatches = params.groups.filter((group) => {
    const groupId = typeof group.id === "string" ? group.id.trim() : "";
    return Boolean(normalized.groupId && groupId === normalized.groupId);
  });
  if (exactIdMatches.length === 1) {
    return toResolved(exactIdMatches[0]!);
  }
  if (exactIdMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous group match" };
  }

  const exactNameMatches = params.groups.filter((group) => {
    const name = typeof group.name === "string" ? group.name.trim().toLowerCase() : "";
    return Boolean(normalized.lower && name === normalized.lower);
  });
  if (exactNameMatches.length === 1) {
    return toResolved(exactNameMatches[0]!);
  }
  if (exactNameMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous group match" };
  }

  const partialNameMatches = params.groups.filter((group) => {
    const name = typeof group.name === "string" ? group.name.trim().toLowerCase() : "";
    return Boolean(normalized.lower && name.includes(normalized.lower));
  });
  if (partialNameMatches.length === 1) {
    return toResolved(partialNameMatches[0]!);
  }
  if (partialNameMatches.length > 1) {
    return { input: params.input, resolved: false, note: "ambiguous group match" };
  }

  return { input: params.input, resolved: false, note: "no matching Signal group" };
}

const signalOutbound = {
  ...signalOutboundBase,
  sendPoll: async (ctx: { cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"]; to: string; poll: { question: string; options: string[]; maxSelections?: number | null }; accountId?: string | null }) => {
    const { cfg, to, poll, accountId } = ctx;
    const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
    if (!createSignalActionGate(actionConfig)("poll")) {
      throw new Error("Signal poll creation is disabled via actions.poll.");
    }
    const result = await sendPollCreateSignal(to, {
      cfg,
      accountId: accountId ?? undefined,
      question: poll.question,
      options: poll.options,
      allowMultiple: (poll.maxSelections ?? 1) > 1,
    });
    return { messageId: result.messageId };
  },
};

export const signalPlugin = createChatChannelPlugin<ResolvedSignalAccount, SignalProbe>({
  base: {
    ...createSignalCustomPluginBase(),
    actions: signalMessageActions,
    mentions: {
      stripPatterns: () => ["\uFFFC"],
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
      parseExplicitTarget: ({ raw }) => parseSignalCustomExplicitTarget(raw),
      inferTargetChatType: ({ to }) => inferSignalCustomTargetChatType(to),
      resolveOutboundSessionRoute: (params) => resolveSignalCustomOutboundSessionRoute(params),
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
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
        if (kind === "group") {
          const groups = await listSignalGroups(
            {
              cfg,
              accountId: accountId ?? undefined,
            },
            { detailed: false },
          );
          return inputs.map((input) => resolveSignalGroupTarget({ groups, input }));
        }
        const contacts = await listSignalContacts({
          cfg,
          accountId: accountId ?? undefined,
        });
        return inputs.map((input) => resolveSignalContactTarget({ contacts, input }));
      },
    },
  },
  pairing: {
    text: {
      idLabel: "signalNumber",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => stripSignalChannelPrefix(entry),
      notify: async ({ cfg, id, message }) => {
        await sendMessageSignal(id, message, { cfg });
      },
    },
  },
  outbound: signalOutbound,
});
