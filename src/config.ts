import {
  DEFAULT_ACCOUNT_ID,
  DmConfigSchema,
  type DmPolicy,
  DmPolicySchema,
  type GroupPolicy,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  normalizeAccountId,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { SIGNAL_CHANNEL_ID } from "./constants.js";

type ToolPolicyBySenderConfig = GroupToolPolicyBySenderConfig;

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const ChannelHeartbeatVisibilitySchema = z
  .object({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();

const RetryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    minDelayMs: z.number().int().min(0).optional(),
    maxDelayMs: z.number().int().min(0).optional(),
    jitter: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

const SignalGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const SignalActionsSchema = z
  .object({
    reactions: z.boolean().optional(),
    unsend: z.boolean().optional(),
    poll: z.boolean().optional(),
    editMessage: z.boolean().optional(),
    deleteMessage: z.boolean().optional(),
    stickers: z.boolean().optional(),
    groupManagement: z.boolean().optional(),
  })
  .strict()
  .optional();

export type SignalRetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type SignalGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: ToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type SignalActionConfig = {
  reactions?: boolean;
  unsend?: boolean;
  poll?: boolean;
  editMessage?: boolean;
  deleteMessage?: boolean;
  stickers?: boolean;
  groupManagement?: boolean;
};

export type SignalAccountConfig = {
  name?: string;
  capabilities?: string[];
  markdown?: unknown;
  configWrites?: boolean;
  ackReaction?: string;
  enabled?: boolean;
  account?: string;
  accountUuid?: string;
  configPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: number;
  tcpHost?: string;
  tcpPort?: number;
  cliPath?: string;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  sseIdleTimeoutMs?: number;
  retry?: SignalRetryConfig;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  injectLinkPreviews?: boolean;
  preserveTextStyles?: boolean;
  sendReadReceipts?: boolean;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, unknown>;
  groups?: Record<string, SignalGroupConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: unknown;
  heartbeat?: {
    showOk?: boolean;
    showAlerts?: boolean;
    useIndicator?: boolean;
  };
  responsePrefix?: string;
  mediaMaxMb?: number;
  reactionNotifications?: SignalReactionNotificationMode;
  reactionAllowlist?: Array<string | number>;
  actions?: SignalActionConfig;
  reactionLevel?: SignalReactionLevel;
};

export type SignalConfig = SignalAccountConfig & {
  accounts?: Record<string, SignalAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  tcpHost?: string;
  tcpPort?: number;
  configured: boolean;
  config: SignalAccountConfig;
};

function normalizeAllowFrom(values?: Array<string | number>): string[] {
  return (values ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function requireOpenAllowFrom(params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) {
  if (params.policy !== "open") {
    return;
  }
  if (normalizeAllowFrom(params.allowFrom).includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
}

function requireAllowlistAllowFrom(params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) {
  if (params.policy !== "allowlist") {
    return;
  }
  if (normalizeAllowFrom(params.allowFrom).length > 0) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
}

export const SignalAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    ackReaction: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    configPath: z.string().optional(),
    httpUrl: z.string().optional(),
    httpHost: z.string().optional(),
    httpPort: z.number().int().positive().optional(),
    tcpHost: z.string().optional(),
    tcpPort: z.number().int().positive().optional(),
    cliPath: z.string().optional(),
    autoStart: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    sseIdleTimeoutMs: z.number().int().min(0).optional(),
    retry: RetryConfigSchema,
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    injectLinkPreviews: z.boolean().optional(),
    preserveTextStyles: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    groups: z.record(z.string(), SignalGroupSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: z.unknown().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    actions: SignalActionsSchema,
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: z.record(z.string(), SignalAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      `channels.${SIGNAL_CHANNEL_ID}.dmPolicy="open" requires channels.${SIGNAL_CHANNEL_ID}.allowFrom to include "*"`,
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      `channels.${SIGNAL_CHANNEL_ID}.dmPolicy="allowlist" requires channels.${SIGNAL_CHANNEL_ID}.allowFrom to contain at least one sender ID`,
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        `channels.${SIGNAL_CHANNEL_ID}.accounts.*.dmPolicy="open" requires channels.${SIGNAL_CHANNEL_ID}.accounts.*.allowFrom (or channels.${SIGNAL_CHANNEL_ID}.allowFrom) to include "*"`,
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        `channels.${SIGNAL_CHANNEL_ID}.accounts.*.dmPolicy="allowlist" requires channels.${SIGNAL_CHANNEL_ID}.accounts.*.allowFrom (or channels.${SIGNAL_CHANNEL_ID}.allowFrom) to contain at least one sender ID`,
    });
  }
});

export function getSignalConfig(cfg: OpenClawConfig): SignalConfig | undefined {
  const channel = cfg.channels?.[SIGNAL_CHANNEL_ID];
  if (!channel || typeof channel !== "object") {
    return undefined;
  }
  return channel as SignalConfig;
}

function resolveAccountEntry(
  accounts: Record<string, SignalAccountConfig> | undefined,
  accountId: string,
): SignalAccountConfig | undefined {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accounts[accountId];
  }
  const normalized = accountId.toLowerCase();
  const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

export function listSignalAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getSignalConfig(cfg);
  const accountIds = channel?.accounts ? Object.keys(channel.accounts).filter(Boolean) : [];
  if (accountIds.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...accountIds].sort((left: string, right: string) => left.localeCompare(right));
}

export function resolveDefaultSignalAccountId(cfg: OpenClawConfig): string {
  const preferredRaw = getSignalConfig(cfg)?.defaultAccount?.trim();
  if (preferredRaw) {
    const preferred = normalizeAccountId(preferredRaw);
    if (listSignalAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)) {
      return preferred;
    }
  }
  const accountIds = listSignalAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  const channel = getSignalConfig(cfg) ?? {};
  const { accounts: _ignored, ...base } = channel;
  const account = resolveAccountEntry(channel.accounts, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channel = getSignalConfig(params.cfg);
  const baseEnabled = channel?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = merged.httpHost?.trim() || "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = merged.httpUrl?.trim() || `http://${host}:${port}`;
  const configured = Boolean(
    merged.account?.trim() ||
      merged.httpUrl?.trim() ||
      merged.configPath?.trim() ||
      merged.cliPath?.trim() ||
      merged.httpHost?.trim() ||
      typeof merged.httpPort === "number" ||
      merged.tcpHost?.trim() ||
      typeof merged.tcpPort === "number" ||
      typeof merged.autoStart === "boolean",
  );
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    tcpHost: merged.tcpHost?.trim() || undefined,
    tcpPort: merged.tcpPort,
    configured,
    config: merged,
  };
}
