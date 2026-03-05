import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type HistoryEntry,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { SignalReactionNotificationMode } from "../config.js";
import { resolveSignalAccount } from "../config.js";
import { SIGNAL_CHANNEL_ID } from "../constants.js";
import { getSignalRuntime } from "../runtime.js";
import {
  isSignalSenderAllowed,
  resolveSignalSender,
  type SignalSender,
} from "./identity.js";
import { signalCheck, signalRpcRequest, streamSignalEvents, type SignalSseEvent } from "./client.js";
import { formatSignalDaemonExit, spawnSignalDaemon, type SignalDaemonHandle } from "./daemon.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type {
  SignalAttachment,
  SignalReactionMessage,
  SignalReactionTarget,
} from "./monitor/event-handler.types.js";
import { sendMessageSignal } from "./send.js";

type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: OpenClawConfig;
  baseUrl?: string;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  reconnectPolicy?: Partial<BackoffPolicy>;
};

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

function resolveRuntime(opts: MonitorSignalOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: () => {},
      error: () => {},
      exit: () => {},
    }
  );
}

function resolveConfig(opts: MonitorSignalOpts): OpenClawConfig {
  return opts.config ?? getSignalRuntime().config.loadConfig();
}

function computeBackoff(params: BackoffPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const withoutJitter = Math.min(params.maxMs, params.initialMs * params.factor ** exponent);
  if (params.jitter <= 0) {
    return Math.trunc(withoutJitter);
  }
  const spread = withoutJitter * params.jitter;
  const randomOffset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.trunc(withoutJitter + randomOffset));
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function mergeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): { signal?: AbortSignal; dispose: () => void } {
  if (!a && !b) {
    return { signal: undefined, dispose: () => {} };
  }
  if (!a) {
    return { signal: b, dispose: () => {} };
  }
  if (!b) {
    return { signal: a, dispose: () => {} };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (a.aborted) {
    abortFrom(a);
    return { signal: controller.signal, dispose: () => {} };
  }
  if (b.aborted) {
    abortFrom(b);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbortA = () => abortFrom(a);
  const onAbortB = () => abortFrom(b);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}

function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const mergedAbort = mergeAbortSignals(params.abortSignal, daemonAbortController.signal);
  const stop = () => {
    daemonStopRequested = true;
    daemonHandle?.stop();
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (daemonStopRequested || params.abortSignal?.aborted) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      if (!daemonAbortController.signal.aborted) {
        daemonAbortController.abort(daemonExitError);
      }
    });
  };
  const getExitError = () => daemonExitError;
  return {
    attach,
    stop,
    getExitError,
    abortSignal: mergedAbort.signal,
    dispose: mergedAbort.dispose,
  };
}

function normalizeAllowList(raw?: Array<string | number>): string[] {
  return (raw ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function resolveSignalReactionTargets(reaction: SignalReactionMessage): SignalReactionTarget[] {
  const targets: SignalReactionTarget[] = [];
  const uuid = reaction.targetAuthorUuid?.trim();
  if (uuid) {
    targets.push({ kind: "uuid", id: uuid, display: `uuid:${uuid}` });
  }
  const author = reaction.targetAuthor?.trim();
  if (author) {
    const sender = resolveSignalSender({ sourceNumber: author });
    if (sender?.kind === "phone") {
      targets.push({ kind: "phone", id: sender.e164, display: sender.e164 });
    }
  }
  return targets;
}

function isSignalReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  if (!reaction) {
    return false;
  }
  const emoji = reaction.emoji?.trim();
  const timestamp = reaction.targetSentTimestamp;
  const hasTarget = Boolean(reaction.targetAuthor?.trim() || reaction.targetAuthorUuid?.trim());
  return Boolean(emoji && typeof timestamp === "number" && timestamp > 0 && hasTarget);
}

function shouldEmitSignalReactionNotification(params: {
  mode?: SignalReactionNotificationMode;
  account?: string | null;
  targets?: SignalReactionTarget[];
  sender?: SignalSender | null;
  allowlist?: string[];
}) {
  const { mode, account, targets, sender, allowlist } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") {
    return false;
  }
  if (effectiveMode === "own") {
    const resolvedAccount = account
      ? resolveSignalSender({ sourceNumber: account }) ?? resolveSignalSender({ sourceUuid: account })
      : null;
    if (!resolvedAccount || !targets || targets.length === 0) {
      return false;
    }
    return targets.some((target) => {
      if (target.kind === "uuid") {
        return resolvedAccount.kind === "uuid" && resolvedAccount.raw === target.id;
      }
      return resolvedAccount.kind === "phone" && resolvedAccount.e164 === target.id;
    });
  }
  if (effectiveMode === "allowlist") {
    if (!sender || !allowlist || allowlist.length === 0) {
      return false;
    }
    return isSignalSenderAllowed(sender, allowlist);
  }
  return true;
}

function buildSignalReactionSystemEventText(params: {
  emojiLabel: string;
  actorLabel: string;
  messageId: string;
  targetLabel?: string;
  groupLabel?: string;
}) {
  const base = `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`;
  const withTarget = params.targetLabel ? `${base} from ${params.targetLabel}` : base;
  return params.groupLabel ? `${withTarget} in ${params.groupLabel}` : withTarget;
}

async function waitForSignalDaemonReady(params: {
  baseUrl: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  logAfterMs: number;
  logIntervalMs?: number;
  runtime: RuntimeEnv;
}): Promise<void> {
  const started = Date.now();
  const timeoutMs = Math.max(0, params.timeoutMs);
  const deadline = started + timeoutMs;
  const logAfterMs = Math.max(0, params.logAfterMs);
  const logIntervalMs = Math.max(1_000, params.logIntervalMs ?? 30_000);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;

  while (true) {
    if (params.abortSignal?.aborted) {
      return;
    }
    const res = await signalCheck(params.baseUrl, 1000);
    if (res.ok) {
      return;
    }
    lastError = res.error ?? null;

    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      const elapsedMs = now - started;
      params.runtime.error?.(
        `signal daemon not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`,
      );
      nextLogAt = now + logIntervalMs;
    }

    try {
      await sleepWithAbort(150, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      throw err;
    }
  }

  params.runtime.error?.(
    `signal daemon not ready after ${timeoutMs}ms (${lastError ?? "unknown error"})`,
  );
  throw new Error(`signal daemon not ready (${lastError ?? "unknown error"})`);
}

async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  attachment: SignalAttachment;
  sender?: string;
  groupId?: string;
  maxBytes: number;
}): Promise<{ path: string; contentType?: string } | null> {
  const { attachment } = params;
  if (!attachment?.id) {
    return null;
  }
  if (attachment.size && attachment.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const rpcParams: Record<string, unknown> = {
    id: attachment.id,
  };
  if (params.account) {
    rpcParams.account = params.account;
  }
  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else if (params.sender) {
    rpcParams.recipient = params.sender;
  } else {
    return null;
  }

  const result = await signalRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
  });
  if (!result?.data) {
    return null;
  }
  const buffer = Buffer.from(result.data, "base64");
  const saved = await getSignalRuntime().channel.media.saveMediaBuffer(
    buffer,
    attachment.contentType ?? undefined,
    "inbound",
    params.maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  baseUrl: string;
  account?: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  chunkMode: "length" | "newline";
}) {
  const { cfg, replies, target, accountId, runtime, maxBytes, textLimit, chunkMode } = params;
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      for (const chunk of getSignalRuntime().channel.text.chunkTextWithMode(
        text,
        textLimit,
        chunkMode,
      )) {
        await sendMessageSignal(target, chunk, {
          cfg,
          accountId,
          maxBytes,
        });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSignal(target, caption, {
          cfg,
          mediaUrl: url,
          maxBytes,
          accountId,
        });
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

async function runSignalSseLoop(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: Partial<BackoffPolicy>;
}) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...params.policy,
  };
  let reconnectAttempts = 0;

  while (!params.abortSignal?.aborted) {
    try {
      await streamSignalEvents({
        baseUrl: params.baseUrl,
        account: params.account,
        abortSignal: params.abortSignal,
        onEvent: (event) => {
          reconnectAttempts = 0;
          params.onEvent(event);
        },
      });
      if (params.abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      if (getSignalRuntime().logging.shouldLogVerbose()) {
        params.runtime.log?.(`Signal SSE stream ended, reconnecting in ${delayMs / 1000}s...`);
      }
      await sleepWithAbort(delayMs, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      params.runtime.error?.(`Signal SSE stream error: ${String(err)}`);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      params.runtime.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, params.abortSignal);
      } catch (sleepErr) {
        if (params.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = resolveConfig(opts);
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const historyLimit = Math.max(
    0,
    accountInfo.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = getSignalRuntime().channel.text.resolveTextChunkLimit(
    cfg,
    SIGNAL_CHANNEL_ID,
    accountInfo.accountId,
  );
  const chunkMode = getSignalRuntime().channel.text.resolveChunkMode(
    cfg,
    SIGNAL_CHANNEL_ID,
    accountInfo.accountId,
  );
  const baseUrl = opts.baseUrl?.trim() || accountInfo.baseUrl;
  const account = opts.account?.trim() || accountInfo.config.account?.trim();
  const dmPolicy = accountInfo.config.dmPolicy ?? "pairing";
  const allowFrom = normalizeAllowList(opts.allowFrom ?? accountInfo.config.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      accountInfo.config.groupAllowFrom ??
      (accountInfo.config.allowFrom && accountInfo.config.allowFrom.length > 0
        ? accountInfo.config.allowFrom
        : []),
  );
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.[SIGNAL_CHANNEL_ID] !== undefined,
      groupPolicy: accountInfo.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: SIGNAL_CHANNEL_ID,
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(message),
  });
  const reactionMode = accountInfo.config.reactionNotifications ?? "own";
  const reactionAllowlist = normalizeAllowList(accountInfo.config.reactionAllowlist);
  const mediaMaxBytes = (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments = opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;
  const sendReadReceipts = Boolean(opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts);

  const autoStart = opts.autoStart ?? accountInfo.config.autoStart ?? !accountInfo.config.httpUrl;
  const startupTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, opts.startupTimeoutMs ?? accountInfo.config.startupTimeoutMs ?? 30_000),
  );
  const readReceiptsViaDaemon = Boolean(autoStart && sendReadReceipts);
  const daemonLifecycle = createSignalDaemonLifecycle({ abortSignal: opts.abortSignal });
  let daemonHandle: SignalDaemonHandle | null = null;

  if (autoStart) {
    const cliPath = opts.cliPath ?? accountInfo.config.cliPath ?? "signal-cli";
    const httpHost = opts.httpHost ?? accountInfo.config.httpHost ?? "127.0.0.1";
    const httpPort = opts.httpPort ?? accountInfo.config.httpPort ?? 8080;
    daemonHandle = spawnSignalDaemon({
      cliPath,
      account,
      httpHost,
      httpPort,
      tcpHost: accountInfo.config.tcpHost,
      tcpPort: accountInfo.config.tcpPort,
      receiveMode: opts.receiveMode ?? accountInfo.config.receiveMode,
      ignoreAttachments: opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? accountInfo.config.ignoreStories,
      sendReadReceipts,
      runtime,
    });
    daemonLifecycle.attach(daemonHandle);
  }

  const onAbort = () => {
    daemonLifecycle.stop();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (daemonHandle) {
      await waitForSignalDaemonReady({
        baseUrl,
        abortSignal: daemonLifecycle.abortSignal,
        timeoutMs: startupTimeoutMs,
        logAfterMs: 10_000,
        logIntervalMs: 10_000,
        runtime,
      });
      const daemonExitError = daemonLifecycle.getExitError();
      if (daemonExitError) {
        throw daemonExitError;
      }
    }

    const handleEvent = createSignalEventHandler({
      runtime,
      cfg,
      baseUrl,
      account,
      accountUuid: accountInfo.config.accountUuid,
      accountId: accountInfo.accountId,
      blockStreaming: accountInfo.config.blockStreaming,
      historyLimit,
      groupHistories,
      textLimit,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      groupPolicy,
      reactionMode,
      reactionAllowlist,
      mediaMaxBytes,
      ignoreAttachments,
      sendReadReceipts,
      readReceiptsViaDaemon,
      fetchAttachment,
      deliverReplies: (params) => deliverReplies({ cfg, ...params, chunkMode }),
      resolveSignalReactionTargets,
      isSignalReactionMessage,
      shouldEmitSignalReactionNotification,
      buildSignalReactionSystemEventText,
    });

    await runSignalSseLoop({
      baseUrl,
      account,
      abortSignal: daemonLifecycle.abortSignal,
      runtime,
      policy: opts.reconnectPolicy,
      onEvent: (event) => {
        void handleEvent(event).catch((err) => {
          runtime.error?.(`event handler failed: ${String(err)}`);
        });
      },
    });
    const daemonExitError = daemonLifecycle.getExitError();
    if (daemonExitError) {
      throw daemonExitError;
    }
  } catch (err) {
    const daemonExitError = daemonLifecycle.getExitError();
    if (opts.abortSignal?.aborted && !daemonExitError) {
      return;
    }
    throw err;
  } finally {
    daemonLifecycle.dispose();
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonLifecycle.stop();
  }
}
