import type { OpenClawConfig } from "../runtime-api.js";
import { resolveSignalAccount } from "../config.js";
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
  description?: string | null;
  pendingMembers?: SignalGroupMember[] | null;
  requestingMembers?: SignalGroupMember[] | null;
  bannedMembers?: SignalGroupMember[] | null;
  permissionAddMember?: string | null;
  permissionEditDetails?: string | null;
  permissionSendMessage?: string | null;
  messageExpirationTimer?: number | null;
  groupInviteLink?: string | null;
  members?: SignalGroupMember[] | null;
  [key: string]: unknown;
};

type SignalDirectoryCacheEntry = {
  value?: unknown;
  cachedAt: number;
  pending?: Promise<unknown>;
};

const DEFAULT_SIGNAL_DIRECTORY_REFRESH_TTL_MS = 5 * 60 * 1000;
const signalDirectoryCache = new Map<string, SignalDirectoryCacheEntry>();

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

function resolveSignalDirectoryRefreshTtlMs(opts: SignalDirectoryOpts): number {
  const account = resolveSignalAccount({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  return Math.max(0, account.config.directoryRefreshTtlMs ?? DEFAULT_SIGNAL_DIRECTORY_REFRESH_TTL_MS);
}

function buildSignalDirectoryCacheKey(params: {
  scope: string;
  context: ReturnType<typeof resolveSignalRpcContext>;
}): string {
  return [
    params.scope,
    params.context.baseUrl,
    params.context.account ?? "",
    params.context.tcpHost ?? "",
    params.context.tcpPort ?? "",
  ].join("|");
}

async function loadCachedSignalDirectoryValue<T>(params: {
  cacheKey: string;
  ttlMs: number;
  load: () => Promise<T>;
}): Promise<T> {
  if (params.ttlMs <= 0) {
    return await params.load();
  }

  const now = Date.now();
  const cached = signalDirectoryCache.get(params.cacheKey);
  if (cached && cached.value !== undefined && now - cached.cachedAt < params.ttlMs) {
    return cached.value as T;
  }
  if (cached?.pending) {
    return await cached.pending as T;
  }

  const pending = params.load()
    .then((value) => {
      signalDirectoryCache.set(params.cacheKey, {
        value,
        cachedAt: Date.now(),
      });
      return value;
    })
    .catch((error) => {
      const current = signalDirectoryCache.get(params.cacheKey);
      if (current?.pending === pending) {
        signalDirectoryCache.delete(params.cacheKey);
      }
      throw error;
    });

  signalDirectoryCache.set(params.cacheKey, {
    cachedAt: cached?.cachedAt ?? 0,
    value: cached?.value,
    pending,
  });

  return await pending;
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
  return await loadCachedSignalDirectoryValue({
    cacheKey: buildSignalDirectoryCacheKey({
      scope: params.detailed === true ? "groups:detailed" : "groups:summary",
      context,
    }),
    ttlMs: resolveSignalDirectoryRefreshTtlMs(opts),
    load: async () => {
      const result = await signalRpcRequestWithRetry("listGroups", rpcParams, {
        baseUrl: context.baseUrl,
        timeoutMs: opts.timeoutMs,
        retry: context.retry,
        tcpHost: context.tcpHost,
        tcpPort: context.tcpPort,
      });
      return Array.isArray(result) ? (result as SignalGroup[]) : [];
    },
  });
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
  return await loadCachedSignalDirectoryValue({
    cacheKey: buildSignalDirectoryCacheKey({
      scope: "contacts",
      context,
    }),
    ttlMs: resolveSignalDirectoryRefreshTtlMs(opts),
    load: async () => {
      const result = await signalRpcRequestWithRetry("listContacts", rpcParams, {
        baseUrl: context.baseUrl,
        timeoutMs: opts.timeoutMs,
        retry: context.retry,
        tcpHost: context.tcpHost,
        tcpPort: context.tcpPort,
      });
      return Array.isArray(result) ? (result as SignalContact[]) : [];
    },
  });
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

export function __clearSignalDirectoryCacheForTests(): void {
  signalDirectoryCache.clear();
}
