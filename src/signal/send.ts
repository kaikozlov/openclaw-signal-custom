import { loadOutboundMediaFromUrl, type OpenClawConfig } from "openclaw/plugin-sdk";
import { SIGNAL_CHANNEL_ID, stripSignalChannelPrefix } from "../constants.js";
import { resolveSignalAccount } from "../config.js";
import { getSignalRuntime } from "../runtime.js";
import { signalRpcRequestWithRetry } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalReactionTarget } from "./reaction-target-cache.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalMentionRange = {
  start: number;
  length: number;
  recipient: string;
};

export type SignalSendOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
  mentions?: SignalMentionRange[];
  silent?: boolean;
  replyTo?: string;
  quoteAuthor?: string;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalRpcOpts = Pick<SignalSendOpts, "cfg" | "accountId" | "timeoutMs">;

export type SignalReceiptType = "read" | "viewed";

export function parseQuoteTimestamp(replyToId?: string | null): number | undefined {
  if (!replyToId) {
    return undefined;
  }
  const timestamp = Number.parseInt(replyToId, 10);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function parseTarget(raw: string): SignalTarget {
  let value = stripSignalChannelPrefix(raw);
  if (!value) {
    throw new Error("Signal recipient is required");
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
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

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

function buildSignalMentionParams(mentions?: SignalMentionRange[]): string[] {
  if (!mentions?.length) {
    return [];
  }
  return mentions.map((mention, index) => {
    if (!Number.isFinite(mention.start) || mention.start < 0) {
      throw new Error(`Signal mention ${index} has an invalid start`);
    }
    if (!Number.isFinite(mention.length) || mention.length <= 0) {
      throw new Error(`Signal mention ${index} has an invalid length`);
    }
    const recipient = normalizeSignalMentionRecipient(mention.recipient, index);
    return `${Math.trunc(mention.start)}:${Math.trunc(mention.length)}:${recipient}`;
  });
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts,
): Promise<SignalSendResult> {
  const cfg = opts.cfg;
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const context = resolveSignalRpcContext({
    cfg,
    accountId: opts.accountId,
  });
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const media = await loadOutboundMediaFromUrl(opts.mediaUrl.trim(), {
      maxBytes,
      mediaLocalRoots: opts.mediaLocalRoots,
    });
    const saved = await getSignalRuntime().channel.media.saveMediaBuffer(
      media.buffer,
      media.contentType ?? undefined,
      "outbound",
      maxBytes,
      media.fileName,
    );
    attachments = [saved.path];
    const kind = media.kind;
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const tableMode = getSignalRuntime().channel.text.resolveMarkdownTableMode({
        cfg,
        channel: SIGNAL_CHANNEL_ID,
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (context.account) {
    params.account = context.account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }
  if (opts.silent) {
    params.noUrgent = true;
  }
  const mentionRanges = buildSignalMentionParams(opts.mentions);
  if (mentionRanges.length > 0) {
    params.mention = mentionRanges;
  }

  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const quoteTimestamp = parseQuoteTimestamp(opts.replyTo);
  const quotedGroupSender =
    quoteTimestamp && target.type === "group"
      ? resolveSignalReactionTarget({
          groupId: target.groupId,
          messageId: String(quoteTimestamp),
        })
      : undefined;
  const quoteAuthor =
    opts.quoteAuthor?.trim() ||
    quotedGroupSender?.targetAuthorUuid ||
    quotedGroupSender?.targetAuthor;
  if (quoteTimestamp && (target.type !== "group" || quoteAuthor)) {
    params.quoteTimestamp = quoteTimestamp;
    if (quoteAuthor) {
      params.quoteAuthor = quoteAuthor;
    }
  }

  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
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

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean },
): Promise<boolean> {
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (context.account) {
    params.account = context.account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequestWithRetry("sendTyping", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType },
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const context = resolveSignalRpcContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (context.account) {
    params.account = context.account;
  }
  await signalRpcRequestWithRetry("sendReceipt", params, {
    baseUrl: context.baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: context.retry,
    tcpHost: context.tcpHost,
    tcpPort: context.tcpPort,
  });
  return true;
}
