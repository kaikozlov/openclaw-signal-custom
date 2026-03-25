import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { z } from "zod";

export const DmConfigSchema = z
  .object({
    historyLimit: z.number().int().min(0).optional(),
  })
  .strict();

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
};

export function createActionGate<T extends Record<string, boolean | undefined>>(
  actions: T | undefined,
): (key: keyof T, defaultValue?: boolean) => boolean {
  return (key, defaultValue = true) => {
    const value = actions?.[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value !== false;
  };
}

export function jsonResult<T>(payload: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(mediaUrl, {
    maxBytes: options.maxBytes,
    localRoots: options.mediaLocalRoots,
  });
}

export function chunkTextForOutbound(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    let breakAt = lastNewline > 0 ? lastNewline : lastSpace;
    if (breakAt <= 0) {
      breakAt = limit;
    }

    const chunk = remaining.slice(0, breakAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function getChannelConfig(
  cfg: OpenClawConfig,
  channel: string,
): Record<string, unknown> | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const value = channels?.[channel];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveAckReaction(
  cfg: OpenClawConfig,
  _agentId: string,
  opts?: { channel?: string; accountId?: string },
): string {
  if (opts?.channel && opts?.accountId) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountReaction = accounts?.[opts.accountId]?.ackReaction as string | undefined;
    if (accountReaction !== undefined) {
      return accountReaction.trim();
    }
  }

  if (opts?.channel) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const channelReaction = channelCfg?.ackReaction as string | undefined;
    if (channelReaction !== undefined) {
      return channelReaction.trim();
    }
  }

  const configured = cfg.messages?.ackReaction;
  if (configured !== undefined) {
    return configured.trim();
  }

  return "\uD83D\uDC40";
}

function resolveResponsePrefix(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  if (params.channel && params.accountId) {
    const channelCfg = getChannelConfig(params.cfg, params.channel);
    const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountPrefix = accounts?.[params.accountId]?.responsePrefix as string | undefined;
    if (accountPrefix !== undefined) {
      return accountPrefix === "auto" ? undefined : accountPrefix;
    }
  }

  if (params.channel) {
    const channelCfg = getChannelConfig(params.cfg, params.channel);
    const channelPrefix = channelCfg?.responsePrefix as string | undefined;
    if (channelPrefix !== undefined) {
      return channelPrefix === "auto" ? undefined : channelPrefix;
    }
  }

  const configured = params.cfg.messages?.responsePrefix;
  if (configured !== undefined) {
    return configured === "auto" ? undefined : configured;
  }
  return undefined;
}

export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): {
  responsePrefix?: string;
  responsePrefixContextProvider: () => Record<string, string>;
  onModelSelected: (ctx: { provider: string; model: string; thinkLevel?: string | null }) => void;
} {
  void params.agentId;
  const prefixContext: Record<string, string> = {};
  return {
    responsePrefix: resolveResponsePrefix(params),
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected: (ctx) => {
      prefixContext.provider = ctx.provider;
      prefixContext.model = ctx.model;
      prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
      prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
    },
  };
}

export function createTypingCallbacks(params: {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
}): {
  onReplyStart: () => Promise<void>;
  onIdle: () => void;
  onCleanup: () => void;
} {
  let stopped = false;

  const stop = () => {
    if (!params.stop || stopped) {
      return;
    }
    stopped = true;
    void params.stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return {
    onReplyStart: async () => {
      stopped = false;
      await params.start().catch(params.onStartError);
    },
    onIdle: stop,
    onCleanup: stop,
  };
}
