import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type HistoryEntry,
  type DmPolicy,
  type GroupPolicy,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import type {
  SignalReactionDeliveryMode,
  SignalReactionNotificationMode,
} from "../config.js";
import { resolveSignalAccount, resolveSignalStreamingMode } from "../config.js";
import { SIGNAL_CHANNEL_ID } from "../constants.js";
import { getSignalRuntime } from "../runtime.js";
import {
  isSignalSenderAllowed,
  resolveSignalSender,
  type SignalSender,
} from "./identity.js";
import { wasSentSignalMessage } from "./sent-message-cache.js";
import { createSignalDisplayNameResolver } from "./display-names.js";
import {
  resolveSignalConnectionMode,
  resolveSignalDirectoryRefreshTtlMs,
} from "./account-inspect.js";
import {
  detectSignalApiMode,
  pollSignalJsonRpc,
  signalCheck,
  signalRpcRequest,
  streamSignalEvents,
  streamSignalSocketEvents,
  type SignalSseEvent,
} from "./client.js";
import { formatSignalDaemonExit, spawnSignalDaemon, type SignalDaemonHandle } from "./daemon.js";
import {
  createSignalGatewaySupervisor,
  type SignalReceiveTransport,
} from "./gateway-supervisor.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type {
  SignalAttachment,
  SignalReactionMessage,
  SignalReactionTarget,
} from "./monitor/event-handler.types.js";
import {
  SignalReconnectExhaustedError,
  buildSignalReconnectLogLine,
  computeSignalBackoff,
  isAbortLikeSignalError,
  normalizeSignalError,
  resolveSignalReconnectPolicy,
  sleepWithSignalAbort,
  type SignalGatewaySupervisionPolicyInput,
  type SignalReconnectPolicyInput,
} from "./reconnect-policy.js";
import { sendMessageSignal } from "./send.js";

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
  configPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  reconnectPolicy?: SignalReconnectPolicyInput;
  supervisionPolicy?: SignalGatewaySupervisionPolicyInput;
  setStatus?: (patch: Record<string, unknown>) => void;
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
    void handle.exited
      .then((exit) => {
        if (daemonStopRequested || params.abortSignal?.aborted) {
          return;
        }
        daemonExitError = new Error(formatSignalDaemonExit(exit));
        if (!daemonAbortController.signal.aborted) {
          daemonAbortController.abort(daemonExitError);
        }
      })
      .catch(() => {});
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

function resolveSignalAttachmentStorePath(configPath?: string): string {
  const trimmedConfigPath = configPath?.trim();
  if (trimmedConfigPath) {
    return path.join(trimmedConfigPath, "attachments");
  }
  const xdgDataHome = process.env["XDG_DATA_HOME"]?.trim();
  const dataHome = xdgDataHome || path.join(homedir(), ".local", "share");
  return path.join(dataHome, "signal-cli", "attachments");
}

function resolveSignalStoredAttachmentPath(params: {
  configPath?: string;
  attachment: SignalAttachment;
}): string | undefined {
  const id = params.attachment.id?.trim();
  if (!id) {
    return undefined;
  }
  const fileName = path.basename(id);
  if (!fileName || fileName !== id) {
    return undefined;
  }
  return path.join(resolveSignalAttachmentStorePath(params.configPath), fileName);
}

function resolveSignalReactionTimestamp(value: number | string | null | undefined): number | null {
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

function resolveSignalReactionTargets(reaction: SignalReactionMessage): SignalReactionTarget[] {
  const targets: SignalReactionTarget[] = [];

  const addUuidTarget = (value?: string | null) => {
    const normalized = value?.trim();
    if (
      !normalized ||
      targets.some((target) => target.kind === "uuid" && target.id === normalized)
    ) {
      return;
    }
    targets.push({ kind: "uuid", id: normalized, display: `uuid:${normalized}` });
  };

  const addPhoneTarget = (value?: string | null) => {
    const sender = typeof value === "string" ? resolveSignalSender({ sourceNumber: value }) : null;
    if (
      sender?.kind !== "phone" ||
      targets.some((target) => target.kind === "phone" && target.id === sender.e164)
    ) {
      return;
    }
    targets.push({ kind: "phone", id: sender.e164, display: sender.e164 });
  };

  addUuidTarget(reaction.targetAuthorUuid);
  addUuidTarget(reaction.targetAuthorAci);
  addUuidTarget(reaction.targetAuthorServiceId);
  addUuidTarget(reaction.targetAuthorId);
  addPhoneTarget(reaction.targetAuthorNumber);
  addPhoneTarget(reaction.targetAuthorE164);
  addPhoneTarget(reaction.targetAuthorPhone);

  if (typeof reaction.targetAuthor === "string") {
    addPhoneTarget(reaction.targetAuthor);
  } else if (reaction.targetAuthor && typeof reaction.targetAuthor === "object") {
    addUuidTarget(reaction.targetAuthor.uuid);
    addUuidTarget(reaction.targetAuthor.aci);
    addUuidTarget(reaction.targetAuthor.serviceId);
    addPhoneTarget(reaction.targetAuthor.number);
    addPhoneTarget(reaction.targetAuthor.e164);
  }
  return targets;
}

function isSignalReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  if (!reaction || typeof reaction !== "object") {
    return false;
  }
  const emoji = typeof reaction.emoji === "string" ? reaction.emoji.trim() : "";
  const timestamp = resolveSignalReactionTimestamp(reaction.targetSentTimestamp);
  if (!emoji || !timestamp) {
    return false;
  }
  const hasTarget = resolveSignalReactionTargets(reaction).length > 0;
  return hasTarget || reaction.isRemove === true || reaction.remove === true;
}

export function shouldEmitSignalReactionNotification(params: {
  mode?: SignalReactionNotificationMode;
  account?: string | null;
  accountUuid?: string | null;
  targets?: SignalReactionTarget[];
  sender?: SignalSender | null;
  allowlist?: string[];
  knownOwnMessage?: boolean;
}) {
  const { mode, account, accountUuid, targets, sender, allowlist, knownOwnMessage } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") {
    return false;
  }
  if (effectiveMode === "own") {
    if (knownOwnMessage) {
      return true;
    }
    const accountId = typeof account === "string" ? account.trim() : "";
    const accountPhone = accountId ? resolveSignalSender({ sourceNumber: accountId }) : null;
    const normalizedAccountUuid =
      typeof accountUuid === "string" ? accountUuid.trim().toLowerCase() : "";
    if (
      (accountPhone?.kind !== "phone" && !normalizedAccountUuid) ||
      !targets ||
      targets.length === 0
    ) {
      return false;
    }
    return targets.some((target) => {
      if (target.kind === "uuid") {
        return Boolean(normalizedAccountUuid && target.id.toLowerCase() === normalizedAccountUuid);
      }
      return accountPhone?.kind === "phone" && accountPhone.e164 === target.id;
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

export function buildSignalReactionSystemEventText(params: {
  emojiLabel: string;
  actorLabel: string;
  actorId?: string;
  messageId: string;
  targetLabel?: string;
  targetIsOwn?: boolean;
  groupLabel?: string;
}) {
  const actor =
    params.actorId && params.actorId !== params.actorLabel
      ? `${params.actorLabel} (${params.actorId})`
      : params.actorLabel;
  const base = `Signal reaction: ${actor} reacted ${params.emojiLabel}`;
  const withTarget = params.targetIsOwn
    ? `${base} to your message (msg ${params.messageId})`
    : params.targetLabel
      ? `${base} to ${params.targetLabel}'s message (msg ${params.messageId})`
      : `${base} to a message (msg ${params.messageId})`;
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
      await sleepWithSignalAbort(150, params.abortSignal);
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

export async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  attachment: SignalAttachment;
  sender?: string;
  groupId?: string;
  maxBytes: number;
  configPath?: string;
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
  const storedAttachmentPath = resolveSignalStoredAttachmentPath({
    configPath: params.configPath,
    attachment,
  });
  if (storedAttachmentPath) {
    try {
      const storedAttachmentStat = await stat(storedAttachmentPath);
      if (storedAttachmentStat.isFile()) {
        if (storedAttachmentStat.size > params.maxBytes) {
          throw new Error(
            `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
          );
        }
        const buffer = await readFile(storedAttachmentPath);
        const saved = await getSignalRuntime().channel.media.saveMediaBuffer(
          buffer,
          attachment.contentType ?? undefined,
          "inbound",
          params.maxBytes,
          path.basename(storedAttachmentPath),
        );
        return { path: saved.path, contentType: saved.contentType };
      }
    } catch {
      // Fall back to getAttachment when the local attachment store does not contain this file.
    }
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
  let buffer: Buffer;
  try {
    buffer = Buffer.from(result.data, "base64");
  } catch {
    return null;
  }
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
  quoteAuthor?: string;
  storyTimestamp?: number;
  storyAuthor?: string;
}) {
  const { cfg, replies, target, accountId, runtime, maxBytes, textLimit, chunkMode } = params;
  const consumedReplyIds = new Set<string>();
  let storyReplyUsed = false;
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) {
      continue;
    }
    const replyToId = payload.replyToId?.trim() || undefined;
    const includeQuote = replyToId !== undefined && !consumedReplyIds.has(replyToId);
    const includeStory =
      !storyReplyUsed &&
      typeof params.storyTimestamp === "number" &&
      Number.isFinite(params.storyTimestamp) &&
      params.storyTimestamp > 0 &&
      Boolean(params.storyAuthor?.trim());
    if (mediaList.length === 0) {
      let first = true;
      for (const chunk of getSignalRuntime().channel.text.chunkTextWithMode(
        text,
        textLimit,
        chunkMode,
      )) {
        await sendMessageSignal(target, chunk, {
          cfg,
          accountId,
          maxBytes,
          replyTo: first && includeQuote ? replyToId : undefined,
          quoteAuthor: first && includeQuote ? params.quoteAuthor : undefined,
          storyTimestamp: first && includeStory ? params.storyTimestamp : undefined,
          storyAuthor: first && includeStory ? params.storyAuthor : undefined,
        });
        if (first && includeQuote && replyToId) {
          consumedReplyIds.add(replyToId);
        }
        if (first && includeStory) {
          storyReplyUsed = true;
        }
        first = false;
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        await sendMessageSignal(target, caption, {
          cfg,
          mediaUrl: url,
          maxBytes,
          accountId,
          replyTo: first && includeQuote ? replyToId : undefined,
          quoteAuthor: first && includeQuote ? params.quoteAuthor : undefined,
          storyTimestamp: first && includeStory ? params.storyTimestamp : undefined,
          storyAuthor: first && includeStory ? params.storyAuthor : undefined,
        });
        if (first && includeQuote && replyToId) {
          consumedReplyIds.add(replyToId);
        }
        if (first && includeStory) {
          storyReplyUsed = true;
        }
        first = false;
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

async function waitForSignalReconnect(params: {
  scope: string;
  error: unknown;
  attempt: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  policy?: SignalReconnectPolicyInput;
}): Promise<void> {
  const reconnectPolicy = resolveSignalReconnectPolicy(params.policy);
  const normalized = normalizeSignalError(params.error);
  if (isAbortLikeSignalError(normalized)) {
    throw normalized;
  }
  if (params.attempt >= reconnectPolicy.maxAttempts) {
    throw new SignalReconnectExhaustedError({
      scope: params.scope,
      attempt: params.attempt,
      maxAttempts: reconnectPolicy.maxAttempts,
      error: normalized,
    });
  }
  const delayMs = computeSignalBackoff(reconnectPolicy, params.attempt);
  params.runtime.log?.(
    buildSignalReconnectLogLine({
      scope: params.scope,
      attempt: params.attempt,
      maxAttempts: reconnectPolicy.maxAttempts,
      delayMs,
      error: normalized,
    }),
  );
  await sleepWithSignalAbort(delayMs, params.abortSignal);
}

async function runSignalSseLoop(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: SignalReconnectPolicyInput;
}) {
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
      if (getSignalRuntime().logging.shouldLogVerbose()) {
        params.runtime.log?.(`Signal SSE stream ended unexpectedly`);
      }
      await waitForSignalReconnect({
        scope: "Signal SSE stream",
        error: new Error("Signal SSE stream ended"),
        attempt: reconnectAttempts,
        abortSignal: params.abortSignal,
        runtime: params.runtime,
        policy: params.policy,
      });
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      try {
        await waitForSignalReconnect({
          scope: "Signal SSE stream",
          error: err,
          attempt: reconnectAttempts,
          abortSignal: params.abortSignal,
          runtime: params.runtime,
          policy: params.policy,
        });
      } catch (sleepErr) {
        if (params.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

async function runSignalJsonRpcPollLoop(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: SignalReconnectPolicyInput;
}) {
  let consecutiveErrors = 0;

  while (!params.abortSignal?.aborted) {
    try {
      await pollSignalJsonRpc({
        baseUrl: params.baseUrl,
        account: params.account,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
        pollTimeoutSec: 10,
      });
      consecutiveErrors = 0;
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      consecutiveErrors += 1;
      try {
        await waitForSignalReconnect({
          scope: "Signal JSON-RPC poll",
          error: err,
          attempt: consecutiveErrors,
          abortSignal: params.abortSignal,
          runtime: params.runtime,
          policy: params.policy,
        });
      } catch (sleepErr) {
        if (params.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

async function runSignalSocketReceiveLoop(params: {
  host: string;
  port: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  receiveMode?: "on-start" | "manual";
  policy?: SignalReconnectPolicyInput;
}) {
  let consecutiveErrors = 0;

  while (!params.abortSignal?.aborted) {
    try {
      await streamSignalSocketEvents({
        host: params.host,
        port: params.port,
        abortSignal: params.abortSignal,
        receiveMode: params.receiveMode,
        onEvent: params.onEvent,
        log: params.runtime.log,
        error: params.runtime.error,
      });
      return;
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      consecutiveErrors += 1;
      try {
        await waitForSignalReconnect({
          scope: "Signal socket receive",
          error: err,
          attempt: consecutiveErrors,
          abortSignal: params.abortSignal,
          runtime: params.runtime,
          policy: params.policy,
        });
      } catch (sleepErr) {
        if (params.abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

async function runSignalReceiveLoop(params: {
  baseUrl: string;
  account?: string;
  tcpHost?: string;
  tcpPort?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  onConnected?: (transport: SignalReceiveTransport) => void;
  receiveMode?: "on-start" | "manual";
  policy?: SignalReconnectPolicyInput;
}): Promise<SignalReceiveTransport> {
  const tcpHost = params.tcpHost?.trim();
  const tcpPort = params.tcpPort;
  if (tcpHost && typeof tcpPort === "number" && Number.isFinite(tcpPort) && tcpPort > 0) {
    params.runtime.log?.(`Signal receive mode: jsonrpc-socket`);
    params.onConnected?.("jsonrpc-socket");
    await runSignalSocketReceiveLoop({
      host: tcpHost,
      port: Math.trunc(tcpPort),
      abortSignal: params.abortSignal,
      runtime: params.runtime,
      onEvent: params.onEvent,
      receiveMode: params.receiveMode,
      policy: params.policy,
    });
    return "jsonrpc-socket";
  }
  const mode = await detectSignalApiMode(params.baseUrl);
  params.runtime.log?.(`Signal receive mode: ${mode}`);
  if (mode === "sse") {
    params.onConnected?.("sse");
    await runSignalSseLoop(params);
    return "sse";
  }
  params.onConnected?.("jsonrpc-poll");
  await runSignalJsonRpcPollLoop(params);
  return "jsonrpc-poll";
}

function resolvePlannedSignalReceiveTransport(params: {
  tcpHost?: string;
  tcpPort?: number;
}): SignalReceiveTransport | null {
  const tcpHost = params.tcpHost?.trim();
  const tcpPort = params.tcpPort;
  if (tcpHost && typeof tcpPort === "number" && Number.isFinite(tcpPort) && tcpPort > 0) {
    return "jsonrpc-socket";
  }
  return null;
}

async function runSignalProviderCycle(params: {
  opts: MonitorSignalOpts;
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  accountInfo: ReturnType<typeof resolveSignalAccount>;
  baseUrl: string;
  account: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  textLimit: number;
  chunkMode: "length" | "newline";
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: GroupPolicy;
  reactionMode: SignalReactionNotificationMode;
  reactionAllowlist: string[];
  reactionDelivery: SignalReactionDeliveryMode;
  mediaMaxBytes: number;
  ignoreAttachments: boolean;
  sendReadReceipts: boolean;
  autoStart: boolean;
  startupTimeoutMs: number;
  configPath?: string;
  displayNameResolver: ReturnType<typeof createSignalDisplayNameResolver>;
  onConnectedTransport?: (transport: SignalReceiveTransport) => void;
}): Promise<SignalReceiveTransport> {
  const { opts, runtime, cfg, accountInfo } = params;
  const readReceiptsViaDaemon = Boolean(params.autoStart && params.sendReadReceipts);
  const daemonLifecycle = createSignalDaemonLifecycle({ abortSignal: opts.abortSignal });
  let daemonHandle: SignalDaemonHandle | null = null;

  if (params.autoStart) {
    const cliPath = opts.cliPath ?? accountInfo.config.cliPath ?? "signal-cli";
    const httpHost = opts.httpHost ?? accountInfo.config.httpHost ?? "127.0.0.1";
    const httpPort = opts.httpPort ?? accountInfo.config.httpPort ?? 8080;
    daemonHandle = spawnSignalDaemon({
      cliPath,
      ...(params.configPath ? { configPath: params.configPath } : {}),
      account: params.account,
      httpHost,
      httpPort,
      tcpHost: accountInfo.config.tcpHost,
      tcpPort: accountInfo.config.tcpPort,
      receiveMode: opts.receiveMode ?? accountInfo.config.receiveMode ?? "manual",
      ignoreAttachments: opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? accountInfo.config.ignoreStories,
      sendReadReceipts: params.sendReadReceipts,
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
        baseUrl: params.baseUrl,
        abortSignal: daemonLifecycle.abortSignal,
        timeoutMs: params.startupTimeoutMs,
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
      baseUrl: params.baseUrl,
      account: params.account,
      accountUuid: accountInfo.config.accountUuid,
      accountLabel: accountInfo.name,
      accountId: accountInfo.accountId,
      streamMode: resolveSignalStreamingMode({
        cfg,
        accountId: accountInfo.accountId,
      }),
      blockStreaming: accountInfo.config.blockStreaming,
      historyLimit: params.historyLimit,
      groupHistories: params.groupHistories,
      textLimit: params.textLimit,
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: params.groupAllowFrom,
      groupPolicy: params.groupPolicy,
      reactionMode: params.reactionMode,
      reactionAllowlist: params.reactionAllowlist,
      reactionDelivery: params.reactionDelivery,
      mediaMaxBytes: params.mediaMaxBytes,
      ignoreAttachments: params.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? accountInfo.config.ignoreStories,
      sendReadReceipts: params.sendReadReceipts,
      readReceiptsViaDaemon,
      injectLinkPreviews: accountInfo.config.injectLinkPreviews,
      preserveTextStyles: accountInfo.config.preserveTextStyles,
      fetchAttachment: (fetchParams) =>
        fetchAttachment({ ...fetchParams, configPath: params.configPath }),
      deliverReplies: (deliverParams) => deliverReplies({ cfg, ...deliverParams, chunkMode: params.chunkMode }),
      resolveSignalReactionTargets,
      isSignalReactionMessage,
      shouldEmitSignalReactionNotification,
      wasSentSignalMessage,
      buildSignalReactionSystemEventText,
      resolveMentionDisplayName: params.displayNameResolver.resolveMentionDisplayName,
      resolveSenderDisplayName: params.displayNameResolver.resolveSenderDisplayName,
    });

    const transport = await runSignalReceiveLoop({
      baseUrl: params.baseUrl,
      account: params.account,
      tcpHost: accountInfo.config.tcpHost,
      tcpPort: accountInfo.config.tcpPort,
      abortSignal: daemonLifecycle.abortSignal,
      runtime,
      onConnected: params.onConnectedTransport,
      receiveMode: opts.receiveMode ?? accountInfo.config.receiveMode ?? "manual",
      policy: opts.reconnectPolicy ?? accountInfo.config.reconnect,
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
    return transport;
  } finally {
    daemonLifecycle.dispose();
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonLifecycle.stop();
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
  const baseUrl =
    (typeof opts.baseUrl === "string" ? opts.baseUrl.trim() : "") || accountInfo.baseUrl;
  const account =
    (typeof opts.account === "string" ? opts.account.trim() : "") ||
    (typeof accountInfo.config.account === "string" ? accountInfo.config.account.trim() : "");
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
  const reactionDelivery = accountInfo.config.reactionDelivery ?? "queue";
  const mediaMaxBytes = (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments = opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;
  const sendReadReceipts = Boolean(opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts);
  const autoStart = opts.autoStart ?? accountInfo.config.autoStart ?? !accountInfo.config.httpUrl;
  const startupTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, opts.startupTimeoutMs ?? accountInfo.config.startupTimeoutMs ?? 30_000),
  );
  const configPathRaw = opts.configPath ?? accountInfo.config.configPath;
  const configPath = configPathRaw?.trim() || undefined;
  const displayNameResolver = createSignalDisplayNameResolver({
    cfg,
    accountId: accountInfo.accountId,
    refreshTtlMs: resolveSignalDirectoryRefreshTtlMs(accountInfo.config),
  });
  const plannedTransport = resolvePlannedSignalReceiveTransport({
    tcpHost: accountInfo.config.tcpHost,
    tcpPort: accountInfo.config.tcpPort,
  });
  const supervisor = createSignalGatewaySupervisor({
    accountId: accountInfo.accountId,
    runtime,
    setStatus: opts.setStatus,
    supervision: opts.supervisionPolicy ?? accountInfo.config.supervision,
    managedDaemon: autoStart,
    connectionMode: resolveSignalConnectionMode(accountInfo.config),
  });
  let restartAttempt = 0;

  try {
    while (!opts.abortSignal?.aborted) {
      supervisor.markStarting(plannedTransport);
      try {
        const activeTransport = await runSignalProviderCycle({
          opts,
          runtime,
          cfg,
          accountInfo,
          baseUrl,
          account,
          historyLimit,
          groupHistories,
          textLimit,
          chunkMode,
          dmPolicy,
          allowFrom,
          groupAllowFrom,
          groupPolicy,
          reactionMode,
          reactionAllowlist,
          reactionDelivery,
          mediaMaxBytes,
          ignoreAttachments,
          sendReadReceipts,
          autoStart,
          startupTimeoutMs,
          configPath,
          displayNameResolver,
          onConnectedTransport: (transport) => {
            restartAttempt = 0;
            supervisor.markConnected(transport);
          },
        });
        if (opts.abortSignal?.aborted) {
          return;
        }
        throw new Error(`Signal receive loop returned unexpectedly (${activeTransport})`);
      } catch (err) {
        if (opts.abortSignal?.aborted || isAbortLikeSignalError(err)) {
          return;
        }
        restartAttempt += 1;
        const shouldContinue = await supervisor.waitBeforeRestart(err, restartAttempt);
        if (!shouldContinue) {
          supervisor.markFailed(err);
          throw err;
        }
      }
    }
  } catch (err) {
    if (opts.abortSignal?.aborted) {
      return;
    }
    supervisor.markFailed(err);
    throw err;
  } finally {
    if (supervisor.phase !== "failed") {
      await supervisor.markStopping();
      supervisor.markStopped();
    }
  }
}
