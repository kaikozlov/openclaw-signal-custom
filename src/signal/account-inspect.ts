import type { OpenClawConfig } from "../runtime-api.js";
import {
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type SignalAccountConfig,
} from "../config.js";
import {
  resolveSignalGatewaySupervisionPolicy,
  resolveSignalReconnectPolicy,
} from "./reconnect-policy.js";

export type SignalConnectionMode = "tcp" | "external-http" | "managed-http";

export type InspectedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  accountNumber?: string;
  baseUrl: string;
  connectionMode: SignalConnectionMode;
  transportSummary: string;
  effectiveAutoStart: boolean;
  configPathSet: boolean;
  attachmentFastPathLikely: boolean;
  receiveMode: "on-start" | "manual";
  directoryRefreshTtlMs: number;
  reconnectMaxAttempts: number;
  supervisionMaxRestarts: number;
  supervisionDrainGraceMs: number;
  config: SignalAccountConfig;
};

export function resolveSignalDirectoryRefreshTtlMs(config: SignalAccountConfig): number {
  return Math.max(0, config.directoryRefreshTtlMs ?? 5 * 60 * 1000);
}

export function resolveSignalReconnectMaxAttempts(config: SignalAccountConfig): number {
  return resolveSignalReconnectPolicy(config.reconnect).maxAttempts;
}

export function resolveSignalSupervisionMaxRestarts(config: SignalAccountConfig): number {
  return resolveSignalGatewaySupervisionPolicy(config.supervision).maxAttempts;
}

export function resolveSignalSupervisionDrainGraceMs(config: SignalAccountConfig): number {
  return resolveSignalGatewaySupervisionPolicy(config.supervision).drainGraceMs;
}

export function resolveSignalConnectionMode(config: SignalAccountConfig): SignalConnectionMode {
  if (config.tcpHost?.trim() || typeof config.tcpPort === "number") {
    return "tcp";
  }
  if (config.httpUrl?.trim()) {
    return "external-http";
  }
  return "managed-http";
}

export function resolveSignalTransportSummary(config: SignalAccountConfig): string {
  const connectionMode = resolveSignalConnectionMode(config);
  if (connectionMode === "tcp") {
    return "managed HTTP + TCP transport";
  }
  if (connectionMode === "external-http") {
    return "external HTTP daemon";
  }
  return "managed HTTP daemon";
}

export function resolveSignalEffectiveAutoStart(config: SignalAccountConfig): boolean {
  return config.autoStart ?? !config.httpUrl?.trim();
}

export function resolveSignalAttachmentFastPathLikely(config: SignalAccountConfig): boolean {
  const connectionMode = resolveSignalConnectionMode(config);
  if (connectionMode !== "external-http") {
    return true;
  }
  return Boolean(config.configPath?.trim());
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
    transportSummary: resolveSignalTransportSummary(resolved.config),
    effectiveAutoStart: resolveSignalEffectiveAutoStart(resolved.config),
    configPathSet: Boolean(resolved.config.configPath?.trim()),
    attachmentFastPathLikely: resolveSignalAttachmentFastPathLikely(resolved.config),
    receiveMode: resolved.config.receiveMode ?? "on-start",
    directoryRefreshTtlMs: resolveSignalDirectoryRefreshTtlMs(resolved.config),
    reconnectMaxAttempts: resolveSignalReconnectMaxAttempts(resolved.config),
    supervisionMaxRestarts: resolveSignalSupervisionMaxRestarts(resolved.config),
    supervisionDrainGraceMs: resolveSignalSupervisionDrainGraceMs(resolved.config),
    config: resolved.config,
  };
}
