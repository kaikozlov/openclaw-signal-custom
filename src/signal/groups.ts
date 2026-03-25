import { signalRpcRequestWithRetry } from "./client.js";
import {
  listSignalGroups,
  type SignalDirectoryOpts,
  type SignalGroup,
  type SignalGroupMember,
} from "./directory.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

function normalizeSignalGroupId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^signal:group:/i, "").replace(/^group:/i, "").trim();
}

function normalizeSignalMemberIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return "";
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

export type SignalGroupUpdate = {
  name?: string;
  description?: string;
  avatar?: string;
  addMembers?: string[];
  removeMembers?: string[];
  addAdmins?: string[];
  removeAdmins?: string[];
  banMembers?: string[];
  unbanMembers?: string[];
  resetLink?: boolean;
  link?: string;
  permissionAddMember?: string;
  permissionEditDetails?: string;
  permissionSendMessages?: string;
  expiration?: number;
  memberLabelEmoji?: string;
  memberLabel?: string;
};

function normalizeSignalStringField(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normalizeSignalMemberIdentifiers(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => normalizeSignalMemberIdentifier(entry)).filter(Boolean);
}

function normalizeSignalGroupLinkState(raw: string | undefined): string | undefined {
  const value = normalizeSignalStringField(raw);
  if (!value) {
    return undefined;
  }
  switch (value.toLowerCase()) {
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

function normalizeSignalGroupPermission(raw: string | undefined): string | undefined {
  const value = normalizeSignalStringField(raw);
  if (!value) {
    return undefined;
  }
  switch (value.toLowerCase()) {
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

export async function listGroupMembersSignal(
  groupId: string,
  opts: SignalDirectoryOpts,
): Promise<SignalGroupMember[]> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal listGroupMembers requires groupId");
  }
  const groups = await listSignalGroups(opts, { detailed: true });
  const group = groups.find((entry) => entry.id?.trim() === normalizedGroupId);
  if (!group) {
    return [];
  }
  return Array.isArray(group.members) ? group.members : [];
}

export async function getGroupInfoSignal(
  groupId: string,
  opts: SignalDirectoryOpts,
): Promise<SignalGroup | null> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal group info requires groupId");
  }
  const groups = await listSignalGroups(opts, { detailed: true });
  return groups.find((entry) => entry.id?.trim() === normalizedGroupId) ?? null;
}

export async function updateGroupSignal(
  groupId: string,
  update: SignalGroupUpdate,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal updateGroup requires groupId");
  }

  const normalizedName = normalizeSignalStringField(update.name);
  const normalizedDescription = normalizeSignalStringField(update.description);
  const normalizedAvatar = normalizeSignalStringField(update.avatar);
  const addMembers = normalizeSignalMemberIdentifiers(update.addMembers);
  const removeMembers = normalizeSignalMemberIdentifiers(update.removeMembers);
  const addAdmins = normalizeSignalMemberIdentifiers(update.addAdmins);
  const removeAdmins = normalizeSignalMemberIdentifiers(update.removeAdmins);
  const banMembers = normalizeSignalMemberIdentifiers(update.banMembers);
  const unbanMembers = normalizeSignalMemberIdentifiers(update.unbanMembers);
  const link = normalizeSignalGroupLinkState(update.link);
  const permissionAddMember = normalizeSignalGroupPermission(update.permissionAddMember);
  const permissionEditDetails = normalizeSignalGroupPermission(update.permissionEditDetails);
  const permissionSendMessages = normalizeSignalGroupPermission(update.permissionSendMessages);
  const memberLabelEmoji = normalizeSignalStringField(update.memberLabelEmoji);
  const memberLabel = normalizeSignalStringField(update.memberLabel);
  const expiration =
    typeof update.expiration === "number" && Number.isInteger(update.expiration) && update.expiration >= 0
      ? update.expiration
      : update.expiration == null
        ? undefined
        : (() => {
            throw new Error("Signal group expiration must be a non-negative integer.");
          })();
  if (
    !normalizedName &&
    !normalizedDescription &&
    !normalizedAvatar &&
    addMembers.length === 0 &&
    removeMembers.length === 0 &&
    addAdmins.length === 0 &&
    removeAdmins.length === 0 &&
    banMembers.length === 0 &&
    unbanMembers.length === 0 &&
    update.resetLink !== true &&
    !link &&
    !permissionAddMember &&
    !permissionEditDetails &&
    !permissionSendMessages &&
    typeof expiration !== "number" &&
    !memberLabelEmoji &&
    !memberLabel
  ) {
    throw new Error("Signal updateGroup requires at least one change");
  }

  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const params: Record<string, unknown> = {
    groupId: normalizedGroupId,
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(normalizedAvatar ? { avatar: normalizedAvatar } : {}),
    ...(addMembers.length > 0 ? { member: addMembers } : {}),
    ...(removeMembers.length > 0 ? { removeMember: removeMembers } : {}),
    ...(addAdmins.length > 0 ? { admin: addAdmins } : {}),
    ...(removeAdmins.length > 0 ? { removeAdmin: removeAdmins } : {}),
    ...(banMembers.length > 0 ? { ban: banMembers } : {}),
    ...(unbanMembers.length > 0 ? { unban: unbanMembers } : {}),
    ...(update.resetLink === true ? { resetLink: true } : {}),
    ...(link ? { link } : {}),
    ...(permissionAddMember ? { setPermissionAddMember: permissionAddMember } : {}),
    ...(permissionEditDetails ? { setPermissionEditDetails: permissionEditDetails } : {}),
    ...(permissionSendMessages ? { setPermissionSendMessages: permissionSendMessages } : {}),
    ...(typeof expiration === "number" ? { expiration } : {}),
    ...(memberLabelEmoji ? { memberLabelEmoji } : {}),
    ...(memberLabel ? { memberLabel } : {}),
  };
  if (context.account) {
    params.account = context.account;
  }
  await signalRpcRequestWithRetry("updateGroup", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
}

export async function addGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal addGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      addMembers: [normalizedMember],
    },
    opts,
  );
}

export async function removeGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal removeGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      removeMembers: [normalizedMember],
    },
    opts,
  );
}

export async function addGroupAdminSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal addGroupAdmin requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      addAdmins: [normalizedMember],
    },
    opts,
  );
}

export async function removeGroupAdminSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal removeGroupAdmin requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      removeAdmins: [normalizedMember],
    },
    opts,
  );
}

export async function banGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal banGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      banMembers: [normalizedMember],
    },
    opts,
  );
}

export async function unbanGroupMemberSignal(
  groupId: string,
  member: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedMember = normalizeSignalMemberIdentifier(member);
  if (!normalizedMember) {
    throw new Error("Signal unbanGroupMember requires member");
  }
  await updateGroupSignal(
    groupId,
    {
      unbanMembers: [normalizedMember],
    },
    opts,
  );
}

export async function joinGroupSignal(uri: string, opts: SignalDirectoryOpts): Promise<void> {
  const normalizedUri = uri.trim();
  if (!normalizedUri) {
    throw new Error("Signal joinGroup requires uri");
  }
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const params: Record<string, unknown> = {
    uri: normalizedUri,
  };
  if (context.account) {
    params.account = context.account;
  }
  await signalRpcRequestWithRetry("joinGroup", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
}

export async function quitGroupSignal(groupId: string, opts: SignalDirectoryOpts): Promise<void> {
  const normalizedGroupId = normalizeSignalGroupId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Signal quitGroup requires groupId");
  }
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const params: Record<string, unknown> = {
    groupId: normalizedGroupId,
  };
  if (context.account) {
    params.account = context.account;
  }
  await signalRpcRequestWithRetry("quitGroup", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
}
