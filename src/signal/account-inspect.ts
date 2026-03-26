import type { OpenClawConfig } from "../runtime-api.js";
import {
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type SignalAccountConfig,
} from "../config.js";

export type SignalConnectionMode = "tcp" | "external-http" | "managed-http";

export type InspectedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  accountNumber?: string;
  baseUrl: string;
  connectionMode: SignalConnectionMode;
  config: SignalAccountConfig;
};

function resolveSignalConnectionMode(config: SignalAccountConfig): SignalConnectionMode {
  if (config.tcpHost?.trim() || typeof config.tcpPort === "number") {
    return "tcp";
  }
  if (config.httpUrl?.trim()) {
    return "external-http";
  }
  return "managed-http";
}

export function inspectSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedSignalAccount {
  const accountId = params.accountId ?? resolveDefaultSignalAccountId(params.cfg);
  const resolved = resolveSignalAccount({
    cfg: params.cfg,
    accountId,
  });
  const accountNumber = resolved.config.account?.trim() || undefined;

  return {
    accountId: resolved.accountId,
    enabled: resolved.enabled,
    name: resolved.name,
    configured: resolved.configured,
    accountNumber,
    baseUrl: resolved.baseUrl,
    connectionMode: resolveSignalConnectionMode(resolved.config),
    config: resolved.config,
  };
}
