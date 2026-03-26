import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "../runtime-api.js";
import { listSignalAccountIds, resolveSignalAccount } from "../config.js";
import { inferSignalCustomTargetChatType } from "../targets.js";

function normalizeApproverId(value: string | number): string {
  return String(value).trim();
}

export function resolveSignalExecApprovalConfig(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
}) {
  return resolveSignalAccount(params).config.execApprovals;
}

export function getSignalExecApprovalApprovers(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
}): string[] {
  return (resolveSignalExecApprovalConfig(params)?.approvers ?? [])
    .map(normalizeApproverId)
    .filter(Boolean);
}

export function isSignalExecApprovalClientEnabled(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
}): boolean {
  const config = resolveSignalExecApprovalConfig(params);
  return Boolean(config?.enabled && getSignalExecApprovalApprovers(params).length > 0);
}

export function resolveSignalExecApprovalTarget(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveSignalExecApprovalConfig(params)?.target ?? "dm";
}

export function hasSignalExecApprovalDmRoute(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
}): boolean {
  return listSignalAccountIds(params.cfg).some((accountId) =>
    isSignalExecApprovalClientEnabled({ cfg: params.cfg, accountId }) &&
    resolveSignalExecApprovalTarget({ cfg: params.cfg, accountId }) !== "channel",
  );
}

export function isSignalExecApprovalTargetEnabled(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
  to: string;
}): boolean {
  if (!isSignalExecApprovalClientEnabled(params)) {
    return false;
  }
  const target = resolveSignalExecApprovalTarget(params);
  const chatType = inferSignalCustomTargetChatType(params.to);
  if (chatType === "group") {
    return target === "channel" || target === "both";
  }
  return target === "dm" || target === "both";
}

export function shouldSuppressLocalSignalExecApprovalPrompt(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return (
    isSignalExecApprovalClientEnabled(params) &&
    getExecApprovalReplyMetadata(params.payload) !== null
  );
}
