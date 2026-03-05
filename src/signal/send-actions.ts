import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { signalRpcRequestWithRetry } from "./client.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalActionRpcOpts = {
  accountId?: string;
  timeoutMs?: number;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalStickerPack = {
  packId?: string;
  id?: string;
  title?: string;
  author?: string;
  installed?: boolean;
  [key: string]: unknown;
};

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return {
      type: "username",
      username: value.slice("u:".length).trim(),
    };
  }
  return { type: "recipient", recipient: value };
}

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

function validateSignalStickerInput(
  packId: string,
  stickerId: number,
): {
  packId: string;
  stickerId: number;
} {
  const normalizedPackId = packId.trim();
  if (!normalizedPackId) {
    throw new Error("Signal sticker send requires packId");
  }
  if (!Number.isFinite(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker send requires a non-negative stickerId");
  }
  return {
    packId: normalizedPackId,
    stickerId: Math.trunc(stickerId),
  };
}

function normalizeStickerPackList(result: unknown): SignalStickerPack[] {
  if (Array.isArray(result)) {
    return result as SignalStickerPack[];
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const packs = (result as { stickerPacks?: unknown }).stickerPacks;
  if (Array.isArray(packs)) {
    return packs as SignalStickerPack[];
  }
  return [];
}

export async function editMessageSignal(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  editTimestamp: number;
  opts?: SignalActionRpcOpts;
}): Promise<SignalSendResult> {
  if (!Number.isFinite(params.editTimestamp) || params.editTimestamp <= 0) {
    throw new Error("Signal edit requires a valid editTimestamp");
  }
  const targetParams = buildTargetParams(parseTarget(params.to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  const content = params.text.trim();
  if (!content) {
    throw new Error("Signal edit requires text");
  }

  const context = resolveSignalRpcContext({
    cfg: params.cfg,
    accountId: params.opts?.accountId,
  });
  const rpcParams: Record<string, unknown> = {
    message: content,
    editTimestamp: params.editTimestamp,
    ...targetParams,
  };
  if (context.account) {
    rpcParams.account = context.account;
  }
  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: params.opts?.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : String(params.editTimestamp),
    timestamp,
  };
}

export async function deleteMessageSignal(params: {
  cfg: OpenClawConfig;
  to: string;
  targetTimestamp: number;
  opts?: SignalActionRpcOpts;
}): Promise<void> {
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    throw new Error("Signal delete requires a valid targetTimestamp");
  }
  const targetParams = buildTargetParams(parseTarget(params.to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }

  const context = resolveSignalRpcContext({
    cfg: params.cfg,
    accountId: params.opts?.accountId,
  });
  const rpcParams: Record<string, unknown> = {
    targetTimestamp: params.targetTimestamp,
    ...targetParams,
  };
  if (context.account) {
    rpcParams.account = context.account;
  }
  await signalRpcRequestWithRetry("remoteDelete", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: params.opts?.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
}

export async function sendStickerSignal(params: {
  cfg: OpenClawConfig;
  to: string;
  packId: string;
  stickerId: number;
  opts?: SignalActionRpcOpts;
}): Promise<SignalSendResult> {
  const targetParams = buildTargetParams(parseTarget(params.to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  const sticker = validateSignalStickerInput(params.packId, params.stickerId);
  const context = resolveSignalRpcContext({
    cfg: params.cfg,
    accountId: params.opts?.accountId,
  });
  const rpcParams: Record<string, unknown> = {
    ...targetParams,
    sticker: `${sticker.packId}:${sticker.stickerId}`,
  };
  if (context.account) {
    rpcParams.account = context.account;
  }
  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: params.opts?.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function listStickerPacksSignal(params: {
  cfg: OpenClawConfig;
  opts?: SignalActionRpcOpts;
}): Promise<SignalStickerPack[]> {
  const context = resolveSignalRpcContext({
    cfg: params.cfg,
    accountId: params.opts?.accountId,
  });
  const rpcParams = context.account ? { account: context.account } : undefined;
  const result = await signalRpcRequestWithRetry("listStickerPacks", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: params.opts?.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  return normalizeStickerPackList(result);
}
