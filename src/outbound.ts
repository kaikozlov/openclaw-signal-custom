import {
  attachChannelToResult,
  attachChannelToResults,
  createEmptyChannelResult,
  resolveOutboundSendDep,
  resolvePayloadMediaUrls,
  resolveSendableOutboundReplyParts,
  resolveTextChunkLimit,
  sendPayloadMediaSequenceOrFallback,
  type ChannelPlugin,
  type OutboundSendDeps,
  type ReplyPayload,
} from "./runtime-api.js";
import {
  getSignalConfig,
  resolveSignalAccount,
  resolveSignalMarkdownTableMode,
  type ResolvedSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID } from "./constants.js";
import { chunkTextForOutbound } from "./text-chunking.js";
import {
  markdownToSignalTextChunks,
  type SignalTextStyleRange,
} from "./signal/format.js";
import {
  sendMessageSignal,
  type SignalMentionRange,
  type SignalSendOpts,
  type SignalSendResult,
} from "./signal/send.js";

type SignalSendFn = (
  to: string,
  text: string,
  opts: SignalSendOpts,
) => Promise<SignalSendResult>;

type SignalSendCtx = {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
  deps?: OutboundSendDeps;
};

type SendSignalDirectParams = SignalSendCtx & {
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  viewOnce?: boolean;
  storyTimestamp?: number;
  storyAuthor?: string;
  silent?: boolean;
  mentions?: SignalMentionRange[];
  textMode?: SignalSendOpts["textMode"];
  textStyles?: SignalTextStyleRange[];
  replyTo?: string;
  quoteAuthor?: string;
};

function resolveSignalSendContext(params: SignalSendCtx) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ?? sendMessageSignal;
  const channelConfig = getSignalConfig(params.cfg);
  const accountId = params.accountId ?? undefined;
  const maxBytes =
    accountId && typeof channelConfig?.accounts?.[accountId]?.mediaMaxMb === "number"
      ? channelConfig.accounts[accountId].mediaMaxMb! * 1024 * 1024
      : typeof channelConfig?.mediaMaxMb === "number"
        ? channelConfig.mediaMaxMb * 1024 * 1024
        : undefined;
  return { send, maxBytes };
}

async function sendSignalDirect(params: SendSignalDirectParams): Promise<SignalSendResult> {
  const { send, maxBytes } = resolveSignalSendContext(params);
  const sendOpts: SignalSendOpts = {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.viewOnce ? { viewOnce: true } : {}),
    ...(typeof params.storyTimestamp === "number" ? { storyTimestamp: params.storyTimestamp } : {}),
    ...(params.storyAuthor ? { storyAuthor: params.storyAuthor } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    ...(params.textMode ? { textMode: params.textMode } : {}),
    ...(params.textStyles?.length ? { textStyles: params.textStyles } : {}),
    ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    ...(params.quoteAuthor ? { quoteAuthor: params.quoteAuthor } : {}),
  };
  if (params.silent) {
    sendOpts.silent = true;
  }
  if (params.mentions?.length) {
    sendOpts.mentions = params.mentions;
  }
  return await send(params.to, params.text, sendOpts);
}

function resolveSignalTextChunks(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
  text: string;
}) {
  const limit = resolveTextChunkLimit(params.cfg, SIGNAL_CHANNEL_ID, params.accountId ?? undefined, {
    fallbackLimit: 4000,
  });
  const tableMode = resolveSignalMarkdownTableMode({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const chunks =
    limit === undefined
      ? markdownToSignalTextChunks(params.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(params.text, limit, { tableMode });
  if (chunks.length === 0 && params.text) {
    return [{ text: params.text, styles: [] }];
  }
  return chunks;
}

async function sendFormattedSignalTextResults(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedSignalAccount>["outbound"]>["sendFormattedText"]>
  >[0] & { storyTimestamp?: number; storyAuthor?: string },
): Promise<SignalSendResult[]> {
  const chunks = resolveSignalTextChunks({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    text: ctx.text,
  });
  const results: SignalSendResult[] = [];
  let firstChunk = true;
  const storyReply = resolveContextStoryReply(ctx);
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const result = await sendSignalDirect({
      cfg: ctx.cfg,
      to: ctx.to,
      text: chunk.text,
      accountId: ctx.accountId,
      deps: ctx.deps,
      silent: ctx.silent ?? undefined,
      textMode: "plain",
      textStyles: chunk.styles,
      replyTo: firstChunk ? (ctx.replyToId ?? undefined) : undefined,
      storyTimestamp: firstChunk ? storyReply?.storyTimestamp : undefined,
      storyAuthor: firstChunk ? storyReply?.storyAuthor : undefined,
    });
    results.push(result);
    firstChunk = false;
  }
  return results;
}

async function sendFormattedSignalMediaResult(
  ctx: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedSignalAccount>["outbound"]>["sendFormattedMedia"]>
  >[0] & { viewOnce?: boolean; storyTimestamp?: number; storyAuthor?: string },
): Promise<SignalSendResult> {
  ctx.abortSignal?.throwIfAborted();
  const formatted =
    resolveSignalTextChunks({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      text: ctx.text,
    })[0] ?? {
      text: ctx.text,
      styles: [],
    };
  return await sendSignalDirect({
    cfg: ctx.cfg,
    to: ctx.to,
    text: formatted.text,
    mediaUrl: ctx.mediaUrl,
    mediaLocalRoots: ctx.mediaLocalRoots,
    viewOnce: resolveContextViewOnce(ctx),
    storyTimestamp: resolveContextStoryReply(ctx)?.storyTimestamp,
    storyAuthor: resolveContextStoryReply(ctx)?.storyAuthor,
    accountId: ctx.accountId,
    deps: ctx.deps,
    silent: ctx.silent ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
    replyTo: ctx.replyToId ?? undefined,
  });
}

type SignalPayloadChannelData = {
  mentions?: unknown;
  viewOnce?: unknown;
  storyReply?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSignalMentionRecipient(raw: string, index: number): string {
  const trimmed = raw.replace(/^signal-custom:/i, "").replace(/^signal:/i, "").trim();
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

function parseSignalMentionRanges(rawMentions: unknown): SignalMentionRange[] | undefined {
  if (!Array.isArray(rawMentions) || rawMentions.length === 0) {
    return undefined;
  }
  return rawMentions.map((rawMention, index) => {
    if (!isRecord(rawMention)) {
      throw new Error(`Signal mention ${index} must be an object`);
    }
    const start = Number(rawMention.start);
    if (!Number.isFinite(start) || start < 0) {
      throw new Error(`Signal mention ${index} has an invalid start`);
    }
    const length = Number(rawMention.length);
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error(`Signal mention ${index} has an invalid length`);
    }
    const recipientRaw = typeof rawMention.recipient === "string" ? rawMention.recipient : "";
    return {
      start: Math.trunc(start),
      length: Math.trunc(length),
      recipient: normalizeSignalMentionRecipient(recipientRaw, index),
    };
  });
}

function resolveSignalPayloadMentions(payload: ReplyPayload): SignalMentionRange[] | undefined {
  if (!isRecord(payload.channelData)) {
    return undefined;
  }
  const signalData = payload.channelData[SIGNAL_CHANNEL_ID] ?? payload.channelData.signal;
  if (!isRecord(signalData)) {
    return undefined;
  }
  const typedSignalData = signalData as SignalPayloadChannelData;
  return parseSignalMentionRanges(typedSignalData.mentions);
}

function resolveSignalPayloadViewOnce(payload: ReplyPayload): boolean | undefined {
  if (!isRecord(payload.channelData)) {
    return undefined;
  }
  const signalData = payload.channelData[SIGNAL_CHANNEL_ID] ?? payload.channelData.signal;
  if (!isRecord(signalData)) {
    return undefined;
  }
  const typedSignalData = signalData as SignalPayloadChannelData;
  return typeof typedSignalData.viewOnce === "boolean" ? typedSignalData.viewOnce : undefined;
}

type SignalStoryReply = {
  storyTimestamp: number;
  storyAuthor: string;
};

function normalizeSignalStoryAuthor(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.replace(/^signal-custom:/i, "").replace(/^signal:/i, "").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    const uuid = trimmed.slice("uuid:".length).trim();
    return uuid || undefined;
  }
  return trimmed;
}

function resolveSignalPayloadStoryReply(payload: ReplyPayload): SignalStoryReply | undefined {
  if (!isRecord(payload.channelData)) {
    return undefined;
  }
  const signalData = payload.channelData[SIGNAL_CHANNEL_ID] ?? payload.channelData.signal;
  if (!isRecord(signalData)) {
    return undefined;
  }
  const typedSignalData = signalData as SignalPayloadChannelData;
  if (!isRecord(typedSignalData.storyReply)) {
    return undefined;
  }
  const storyTimestampRaw =
    typedSignalData.storyReply.storyTimestamp ??
    typedSignalData.storyReply.timestamp ??
    typedSignalData.storyReply.sentTimestamp;
  const storyTimestamp =
    typeof storyTimestampRaw === "number"
      ? storyTimestampRaw
      : typeof storyTimestampRaw === "string"
        ? Number(storyTimestampRaw)
        : Number.NaN;
  if (!Number.isFinite(storyTimestamp) || storyTimestamp <= 0) {
    throw new Error("Signal storyReply requires a positive story timestamp");
  }
  const storyAuthor =
    normalizeSignalStoryAuthor(typedSignalData.storyReply.storyAuthor) ??
    normalizeSignalStoryAuthor(typedSignalData.storyReply.author) ??
    normalizeSignalStoryAuthor(typedSignalData.storyReply.authorNumber) ??
    normalizeSignalStoryAuthor(typedSignalData.storyReply.authorUuid);
  if (!storyAuthor) {
    throw new Error("Signal storyReply requires a story author");
  }
  return {
    storyTimestamp: Math.trunc(storyTimestamp),
    storyAuthor,
  };
}

function resolvePayloadText(payload: ReplyPayload, text: string) {
  return resolveSendableOutboundReplyParts(payload, {
    text: payload.text ?? text,
  });
}

function resolveContextViewOnce(ctx: { viewOnce?: boolean } | undefined): boolean | undefined {
  return typeof ctx?.viewOnce === "boolean" ? ctx.viewOnce : undefined;
}

function resolveContextStoryReply(
  ctx: { storyTimestamp?: number; storyAuthor?: string } | undefined,
): SignalStoryReply | undefined {
  if (
    typeof ctx?.storyTimestamp === "number" &&
    Number.isFinite(ctx.storyTimestamp) &&
    ctx.storyTimestamp > 0 &&
    ctx.storyAuthor?.trim()
  ) {
    return {
      storyTimestamp: Math.trunc(ctx.storyTimestamp),
      storyAuthor: ctx.storyAuthor.trim(),
    };
  }
  return undefined;
}

export const signalOutboundBase: Pick<
  NonNullable<ChannelPlugin<ResolvedSignalAccount>["outbound"]>,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "sendPayload"
  | "sendFormattedText"
  | "sendFormattedMedia"
  | "sendText"
  | "sendMedia"
> = {
  deliveryMode: "direct",
  chunker: (text, limit) => chunkTextForOutbound(text, limit),
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendFormattedText: async (ctx) =>
    attachChannelToResults(SIGNAL_CHANNEL_ID, await sendFormattedSignalTextResults(ctx)),
  sendFormattedMedia: async (ctx) =>
    attachChannelToResult(SIGNAL_CHANNEL_ID, await sendFormattedSignalMediaResult(ctx)),
  sendPayload: async (ctx) => {
    const parts = resolvePayloadText(ctx.payload, ctx.text);
    const mentions = resolveSignalPayloadMentions(ctx.payload);
    const viewOnce = resolveSignalPayloadViewOnce(ctx.payload);
    const storyReply = resolveSignalPayloadStoryReply(ctx.payload);
    const replyToId = ctx.payload.replyToId?.trim() || ctx.replyToId?.trim() || undefined;
    if (!parts.hasContent) {
      return createEmptyChannelResult(SIGNAL_CHANNEL_ID);
    }
    if (viewOnce) {
      if (parts.mediaCount !== 1) {
        throw new Error("Signal view-once requires exactly one media attachment");
      }
      if (mentions?.length) {
        throw new Error("Signal view-once is not supported with native mention payloads");
      }
    }

    if (mentions?.length) {
      const rawResult = await sendPayloadMediaSequenceOrFallback({
        text: parts.text,
        mediaUrls: resolvePayloadMediaUrls(ctx.payload),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendSignalDirect({
            cfg: ctx.cfg,
            to: ctx.to,
            text,
            mediaUrl,
            mediaLocalRoots: ctx.mediaLocalRoots,
            accountId: ctx.accountId,
            deps: ctx.deps,
            viewOnce,
            storyTimestamp: isFirst ? storyReply?.storyTimestamp : undefined,
            storyAuthor: isFirst ? storyReply?.storyAuthor : undefined,
            silent: ctx.silent ?? undefined,
            mentions: isFirst ? mentions : undefined,
            replyTo: isFirst ? replyToId : undefined,
          }),
        fallbackResult: { messageId: "" },
        sendNoMedia: async () =>
          await sendSignalDirect({
            cfg: ctx.cfg,
            to: ctx.to,
            text: parts.text,
            accountId: ctx.accountId,
            deps: ctx.deps,
            silent: ctx.silent ?? undefined,
            mentions,
            replyTo: replyToId,
          }),
      });
      return attachChannelToResult(SIGNAL_CHANNEL_ID, rawResult);
    }

    if (parts.hasMedia) {
      const rawResult = await sendPayloadMediaSequenceOrFallback({
        text: parts.text,
        mediaUrls: parts.mediaUrls,
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendFormattedSignalMediaResult({
            ...ctx,
            text,
            mediaUrl,
            replyToId: isFirst ? replyToId : undefined,
            viewOnce,
            storyTimestamp: isFirst ? storyReply?.storyTimestamp : undefined,
            storyAuthor: isFirst ? storyReply?.storyAuthor : undefined,
          }),
        fallbackResult: { messageId: "" },
        sendNoMedia: async () => {
          const results = await sendFormattedSignalTextResults({
            ...ctx,
            text: parts.text,
            replyToId,
            storyTimestamp: storyReply?.storyTimestamp,
            storyAuthor: storyReply?.storyAuthor,
          });
          return results.at(-1) ?? { messageId: "" };
        },
      });
      return attachChannelToResult(SIGNAL_CHANNEL_ID, rawResult);
    }

    const results = await sendFormattedSignalTextResults({
      ...ctx,
      text: parts.text,
      replyToId,
      storyTimestamp: storyReply?.storyTimestamp,
      storyAuthor: storyReply?.storyAuthor,
    });
    return attachChannelToResult(
      SIGNAL_CHANNEL_ID,
      results.at(-1) ?? { messageId: "" },
    );
  },
  sendText: async (ctx) =>
    attachChannelToResult(
      SIGNAL_CHANNEL_ID,
      await sendSignalDirect({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId: ctx.accountId,
        deps: ctx.deps,
        viewOnce: resolveContextViewOnce(ctx as { viewOnce?: boolean }),
        storyTimestamp: resolveContextStoryReply(
          ctx as { storyTimestamp?: number; storyAuthor?: string },
        )?.storyTimestamp,
        storyAuthor: resolveContextStoryReply(
          ctx as { storyTimestamp?: number; storyAuthor?: string },
        )?.storyAuthor,
        silent: ctx.silent ?? undefined,
        replyTo: ctx.replyToId ?? undefined,
      }),
    ),
  sendMedia: async (ctx) =>
    attachChannelToResult(
      SIGNAL_CHANNEL_ID,
      await sendSignalDirect({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots,
        accountId: ctx.accountId,
        deps: ctx.deps,
        viewOnce: resolveContextViewOnce(ctx as { viewOnce?: boolean }),
        storyTimestamp: resolveContextStoryReply(
          ctx as { storyTimestamp?: number; storyAuthor?: string },
        )?.storyTimestamp,
        storyAuthor: resolveContextStoryReply(
          ctx as { storyTimestamp?: number; storyAuthor?: string },
        )?.storyAuthor,
        silent: ctx.silent ?? undefined,
        replyTo: ctx.replyToId ?? undefined,
      }),
    ),
};
