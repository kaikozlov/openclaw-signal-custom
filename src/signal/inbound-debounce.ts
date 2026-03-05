import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getSignalRuntime } from "../runtime.js";

export function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: OpenClawConfig;
  hasMedia?: boolean;
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    return false;
  }
  const text = params.text?.trim() ?? "";
  if (!text) {
    return false;
  }
  return !getSignalRuntime().channel.text.hasControlCommand(text, params.cfg);
}

export function createChannelInboundDebouncer<T>(
  params: {
    cfg: OpenClawConfig;
    channel: string;
    debounceMsOverride?: number;
    buildKey: (item: T) => string | null | undefined;
    shouldDebounce?: (item: T) => boolean;
    resolveDebounceMs?: (item: T) => number | undefined;
    onFlush: (items: T[]) => Promise<void>;
    onError?: (err: unknown, items: T[]) => void;
  },
): {
  debounceMs: number;
  debouncer: {
    enqueue: (item: T) => Promise<void>;
    flushKey: (key: string) => Promise<void>;
  };
} {
  const debounceMs = getSignalRuntime().channel.debounce.resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: params.channel,
    overrideMs: params.debounceMsOverride,
  });
  const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
  const debouncer = getSignalRuntime().channel.debounce.createInboundDebouncer<T>({
    debounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}
