import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveSignalAccount, type SignalRetryConfig } from "../config.js";

type SignalTransportConfig = {
  tcpHost?: unknown;
  tcpPort?: unknown;
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
  const transportConfig = accountInfo.config as SignalTransportConfig;
  const tcpHost =
    typeof transportConfig.tcpHost === "string" && transportConfig.tcpHost.trim()
      ? transportConfig.tcpHost.trim()
      : undefined;
  const tcpPort =
    typeof transportConfig.tcpPort === "number" &&
    Number.isFinite(transportConfig.tcpPort) &&
    transportConfig.tcpPort > 0
      ? Math.trunc(transportConfig.tcpPort)
      : undefined;
  return {
    baseUrl: accountInfo.baseUrl,
    account: account || undefined,
    retry,
    tcpHost,
    tcpPort,
  };
}
