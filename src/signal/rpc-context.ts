import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveSignalAccount } from "openclaw/plugin-sdk";

export type SignalRetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

function parseRetryConfig(raw: unknown): SignalRetryConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const retry = raw as Record<string, unknown>;
  return {
    ...(typeof retry.attempts === "number" ? { attempts: retry.attempts } : {}),
    ...(typeof retry.minDelayMs === "number" ? { minDelayMs: retry.minDelayMs } : {}),
    ...(typeof retry.maxDelayMs === "number" ? { maxDelayMs: retry.maxDelayMs } : {}),
    ...(typeof retry.jitter === "number" ? { jitter: retry.jitter } : {}),
  };
}

export function resolveSignalRpcContext(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  const accountInfo = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const accountRaw = accountInfo.config.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  const retry = parseRetryConfig((accountInfo.config as { retry?: unknown }).retry);
  return {
    baseUrl: accountInfo.baseUrl,
    account: account || undefined,
    retry,
  };
}
