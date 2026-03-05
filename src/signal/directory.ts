import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { signalRpcRequestWithRetry } from "./client.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalDirectoryOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  timeoutMs?: number;
};

export type SignalContact = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  [key: string]: unknown;
};

export type SignalGroupMember = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  [key: string]: unknown;
};

export type SignalGroup = {
  id?: string | null;
  name?: string | null;
  members?: SignalGroupMember[] | null;
  [key: string]: unknown;
};

function normalizeSignalDirectoryIdentifier(raw: string): string {
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

export async function listSignalGroups(
  opts: SignalDirectoryOpts,
  params: { detailed?: boolean } = {},
): Promise<SignalGroup[]> {
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const rpcParams: Record<string, unknown> = {};
  if (params.detailed === true) {
    rpcParams.detailed = true;
  }
  if (context.account) {
    rpcParams.account = context.account;
  }
  const result = await signalRpcRequestWithRetry("listGroups", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  return Array.isArray(result) ? (result as SignalGroup[]) : [];
}

export async function listSignalContacts(opts: SignalDirectoryOpts): Promise<SignalContact[]> {
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const rpcParams: Record<string, unknown> = {};
  if (context.account) {
    rpcParams.account = context.account;
  }
  const result = await signalRpcRequestWithRetry("listContacts", rpcParams, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  return Array.isArray(result) ? (result as SignalContact[]) : [];
}

export async function updateContactSignal(
  recipient: string,
  name: string,
  opts: SignalDirectoryOpts,
): Promise<void> {
  const normalizedRecipient = normalizeSignalDirectoryIdentifier(recipient);
  if (!normalizedRecipient) {
    throw new Error("Signal update contact requires recipient");
  }
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Signal update contact requires name");
  }
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const params: Record<string, unknown> = {
    recipient: normalizedRecipient,
    name: normalizedName,
  };
  if (context.account) {
    params.account = context.account;
  }
  await signalRpcRequestWithRetry("updateContact", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
}
