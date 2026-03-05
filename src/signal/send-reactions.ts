import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { signalRpcRequestWithRetry } from "./client.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalReactionOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  timeoutMs?: number;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
};

export type SignalReactionResult = {
  ok: boolean;
  timestamp?: number;
};

type SignalSendReactionRecipientResult = {
  type?: string;
  recipientAddress?: {
    uuid?: string | null;
    number?: string | null;
    username?: string | null;
  } | null;
};

type SignalSendReactionRpcResult = {
  timestamp?: number;
  results?: SignalSendReactionRecipientResult[];
};

type SignalReactionErrorMessages = {
  missingRecipient: string;
  invalidTargetTimestamp: string;
  missingEmoji: string;
  missingGroupTargetAuthor: string;
  missingDirectTargetAuthor: string;
};

function normalizeSignalId(raw: string): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^signal:/i, "").trim();
}

function normalizeSignalUuid(raw: string): string {
  const trimmed = normalizeSignalId(raw);
  if (!trimmed) {
    return "";
  }
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    return trimmed.slice("uuid:".length).trim();
  }
  return trimmed;
}

function resolveTargetAuthorParams(params: {
  targetAuthor?: string;
  targetAuthorUuid?: string;
}): {
  targetAuthor?: string;
} {
  const candidates = [params.targetAuthor, params.targetAuthorUuid];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const raw = candidate.trim();
    if (!raw) {
      continue;
    }
    const normalized = normalizeSignalUuid(raw);
    if (normalized) {
      return { targetAuthor: normalized };
    }
  }
  return {};
}

function resolveReactionRecipientLabel(entry: SignalSendReactionRecipientResult): string {
  const number = entry.recipientAddress?.number?.trim();
  if (number) {
    return number;
  }
  const uuid = entry.recipientAddress?.uuid?.trim();
  if (uuid) {
    return `uuid:${uuid}`;
  }
  const username = entry.recipientAddress?.username?.trim();
  if (username) {
    return username;
  }
  return "unknown";
}

async function sendReactionSignalCore(params: {
  recipient: string;
  targetTimestamp: number;
  emoji: string;
  remove: boolean;
  opts: SignalReactionOpts;
  errors: SignalReactionErrorMessages;
}): Promise<SignalReactionResult> {
  const context = resolveSignalRpcContext({
    cfg: params.opts.cfg,
    accountId: params.opts.accountId,
  });

  const normalizedRecipient = normalizeSignalUuid(params.recipient);
  const groupId = params.opts.groupId?.trim();
  if (!normalizedRecipient && !groupId) {
    throw new Error(params.errors.missingRecipient);
  }
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    throw new Error(params.errors.invalidTargetTimestamp);
  }
  const normalizedEmoji = params.emoji?.trim();
  if (!normalizedEmoji) {
    throw new Error(params.errors.missingEmoji);
  }

  const targetAuthorParams = resolveTargetAuthorParams({
    targetAuthor: params.opts.targetAuthor,
    targetAuthorUuid: params.opts.targetAuthorUuid,
  });
  if (groupId && !targetAuthorParams.targetAuthor) {
    throw new Error(params.errors.missingGroupTargetAuthor);
  }
  if (!groupId && !targetAuthorParams.targetAuthor) {
    throw new Error(params.errors.missingDirectTargetAuthor);
  }

  const resolvedTargetAuthor = targetAuthorParams.targetAuthor;

  const requestParams: Record<string, unknown> = {
    emoji: normalizedEmoji,
    targetTimestamp: params.targetTimestamp,
    ...(params.remove ? { remove: true } : {}),
    ...(resolvedTargetAuthor ? { targetAuthor: resolvedTargetAuthor } : {}),
  };
  if (normalizedRecipient) {
    requestParams.recipients = [normalizedRecipient];
  }
  if (groupId) {
    requestParams.groupIds = [groupId];
  }
  if (context.account) {
    requestParams.account = context.account;
  }

  const result = await signalRpcRequestWithRetry<SignalSendReactionRpcResult>(
    "sendReaction",
    requestParams,
    {
      baseUrl: context.baseUrl,
      timeoutMs: params.opts.timeoutMs,
      retry: context.retry,
      tcpHost: context.tcpHost,
      tcpPort: context.tcpPort,
    },
  );
  const failures =
    result.results?.filter((entry) => String(entry.type ?? "").toUpperCase() !== "SUCCESS") ?? [];
  if (failures.length > 0) {
    const details = failures
      .map((entry) => `${resolveReactionRecipientLabel(entry)}:${String(entry.type ?? "UNKNOWN")}`)
      .join(", ");
    throw new Error(`Signal sendReaction failed for recipient result(s): ${details}`);
  }

  return {
    ok: true,
    timestamp: result.timestamp,
  };
}

export async function sendReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: false,
    opts,
    errors: {
      missingRecipient: "Recipient or groupId is required for Signal reaction",
      invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction",
      missingEmoji: "Emoji is required for Signal reaction",
      missingGroupTargetAuthor: "targetAuthor is required for group reactions",
      missingDirectTargetAuthor: "targetAuthor is required for direct reactions",
    },
  });
}

export async function removeReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: true,
    opts,
    errors: {
      missingRecipient: "Recipient or groupId is required for Signal reaction removal",
      invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction removal",
      missingEmoji: "Emoji is required for Signal reaction removal",
      missingGroupTargetAuthor: "targetAuthor is required for group reaction removal",
      missingDirectTargetAuthor: "targetAuthor is required for direct reaction removal",
    },
  });
}
