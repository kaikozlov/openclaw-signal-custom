import {
  adaptScopedAccountAccessor,
  applyAccountNameToChannelSection,
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  buildDmGroupAccountAllowlistAdapter,
  collectStatusIssuesFromLastError,
  createChannelPluginBase,
  createComputedAccountStatusAdapter,
  createScopedChannelConfigAdapter,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  type ChannelPlugin,
} from "./runtime-api.js";
import {
  getSignalConfig,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  SignalConfigSchema,
  type ResolvedSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID, SIGNAL_META } from "./constants.js";
import { monitorSignalProvider } from "./signal/monitor.js";
import { probeSignal, type SignalProbe } from "./signal/probe.js";
import { listSignalContacts, type SignalContact } from "./signal/directory.js";
import { resolveSignalAllowlistGroupOverrides } from "./signal/group-config.js";
import {
  inspectSignalAccount,
  resolveSignalAttachmentFastPathLikely,
  resolveSignalConnectionMode,
  resolveSignalDirectoryRefreshTtlMs,
  resolveSignalEffectiveAutoStart,
  resolveSignalReconnectMaxAttempts,
  resolveSignalSupervisionDrainGraceMs,
  resolveSignalSupervisionMaxRestarts,
  resolveSignalTransportSummary,
} from "./signal/account-inspect.js";
import { normalizeSignalAllowlistEntry } from "./signal/allowlist.js";
import { signalCustomSetupWizard } from "./setup-wizard.js";

function readRuntimeExtraBool(
  runtime: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  return typeof runtime?.[key] === "boolean" ? (runtime[key] as boolean) : fallback;
}

function readRuntimeExtraNumber(
  runtime: Record<string, unknown> | undefined,
  key: string,
  fallback: number | null,
): number | null {
  return typeof runtime?.[key] === "number" && Number.isFinite(runtime[key])
    ? (runtime[key] as number)
    : fallback;
}

function readRuntimeExtraUnknown(
  runtime: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return runtime?.[key];
}

function normalizeSignalAllowlistLookupKey(raw: string): string {
  return normalizeSignalAllowlistEntry(raw);
}

function buildSignalAllowlistContactNameMap(contacts: SignalContact[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const contact of contacts) {
    const name = typeof contact.name === "string" ? contact.name.trim() : "";
    if (!name) {
      continue;
    }
    const number =
      typeof contact.number === "string" ? normalizeSignalAllowlistLookupKey(contact.number) : "";
    const uuid =
      typeof contact.uuid === "string" ? normalizeSignalAllowlistLookupKey(`uuid:${contact.uuid}`) : "";
    if (number) {
      map.set(number, name);
    }
    if (uuid) {
      map.set(uuid, name);
    }
  }
  return map;
}

async function resolveSignalAllowlistNames(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
  entries: string[];
}) {
  const contacts = await listSignalContacts({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const byKey = buildSignalAllowlistContactNameMap(contacts);
  return params.entries.map((input) => {
    const key = normalizeSignalAllowlistLookupKey(input);
    const name = key ? byKey.get(key) : undefined;
    return {
      input,
      resolved: Boolean(name),
      ...(name ? { name } : {}),
    };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
  };
}

export const signalCustomConfigAdapter = createScopedChannelConfigAdapter<ResolvedSignalAccount>({
  sectionKey: SIGNAL_CHANNEL_ID,
  listAccountIds: listSignalAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveSignalAccount),
  inspectAccount: adaptScopedAccountAccessor(inspectSignalAccount),
  defaultAccountId: resolveDefaultSignalAccountId,
  clearBaseFields: [
    "account",
    "httpUrl",
    "httpHost",
    "httpPort",
    "cliPath",
    "configPath",
    "name",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => normalizeSignalAllowlistEntry(entry))
      .filter(Boolean),
  resolveDefaultTo: (account) => account.config.defaultTo,
  allowTopLevel: true,
});

export const signalCustomAllowlistAdapter: NonNullable<
  ChannelPlugin<ResolvedSignalAccount>["allowlist"]
> = {
  ...buildDmGroupAccountAllowlistAdapter({
    channelId: SIGNAL_CHANNEL_ID,
    resolveAccount: resolveSignalAccount,
    normalize: ({ cfg, accountId, values }) =>
      signalCustomConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
    resolveDmAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
    resolveGroupAllowFrom: (account: ResolvedSignalAccount) => account.config.groupAllowFrom,
    resolveDmPolicy: (account: ResolvedSignalAccount) => account.config.dmPolicy,
    resolveGroupPolicy: (account: ResolvedSignalAccount) => account.config.groupPolicy,
    resolveGroupOverrides: (account: ResolvedSignalAccount) =>
      resolveSignalAllowlistGroupOverrides(account.config.groups),
  }),
  resolveNames: async ({ cfg, accountId, entries }) =>
    await resolveSignalAllowlistNames({ cfg, accountId, entries }),
};

export const signalSetupAdapter: NonNullable<ChannelPlugin<ResolvedSignalAccount>["setup"]> = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: SIGNAL_CHANNEL_ID,
      accountId,
      name,
    }),
  validateInput: ({ input }) => {
    if (
      !input.signalNumber &&
      !input.httpUrl &&
      !input.httpHost &&
      !input.httpPort &&
      !input.cliPath
    ) {
      return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: SIGNAL_CHANNEL_ID,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: SIGNAL_CHANNEL_ID,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          [SIGNAL_CHANNEL_ID]: {
            ...next.channels?.[SIGNAL_CHANNEL_ID],
            enabled: true,
            ...buildSignalSetupPatch(input),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        [SIGNAL_CHANNEL_ID]: {
          ...next.channels?.[SIGNAL_CHANNEL_ID],
          enabled: true,
          accounts: {
            ...getSignalConfig(next)?.accounts,
            [accountId]: {
              ...getSignalConfig(next)?.accounts?.[accountId],
              enabled: true,
              ...buildSignalSetupPatch(input),
            },
          },
        },
      },
    };
  },
};

export const signalCustomStatusAdapter = createComputedAccountStatusAdapter<
  ResolvedSignalAccount,
  SignalProbe
>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
    connected: false,
    restartPending: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    healthState: "stopped",
    supervisorState: "stopped",
    receiveTransport: null,
    supervisionRestarts: 0,
    managedDaemon: null,
    connectionMode: null,
  }),
  collectStatusIssues: (accounts) => collectStatusIssuesFromLastError(SIGNAL_CHANNEL_ID, accounts),
  buildChannelSummary: ({ snapshot }) => ({
    ...buildBaseChannelStatusSummary(snapshot),
    baseUrl: snapshot.baseUrl ?? null,
    connected: snapshot.connected ?? false,
    restartPending: snapshot.restartPending ?? false,
    reconnectAttempts: snapshot.reconnectAttempts ?? 0,
    healthState: snapshot.healthState ?? null,
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  }),
  probeAccount: async ({ account, timeoutMs }) => await probeSignal(account.baseUrl, timeoutMs),
  formatCapabilitiesProbe: ({ probe }) =>
    probe?.version
      ? [{ text: `Signal daemon: ${probe.version}` }]
      : probe?.error
        ? [{ text: `Signal probe error: ${probe.error}` }]
        : [],
  resolveAccountSnapshot: ({ account, runtime }) => {
    const runtimeExtra = runtime as Record<string, unknown> | undefined;
    return {
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      extra: {
        baseUrl: account.baseUrl,
        connectionMode: resolveSignalConnectionMode(account.config),
        transportSummary: resolveSignalTransportSummary(account.config),
        effectiveAutoStart: resolveSignalEffectiveAutoStart(account.config),
        configPathSet: Boolean(account.config.configPath?.trim()),
        attachmentFastPathLikely: resolveSignalAttachmentFastPathLikely(account.config),
        receiveMode: account.config.receiveMode ?? "on-start",
        directoryRefreshTtlMs: resolveSignalDirectoryRefreshTtlMs(account.config),
        reconnectMaxAttempts: resolveSignalReconnectMaxAttempts(account.config),
        supervisionMaxRestarts: resolveSignalSupervisionMaxRestarts(account.config),
        supervisionDrainGraceMs: resolveSignalSupervisionDrainGraceMs(account.config),
        connected: runtime?.connected ?? false,
        restartPending: runtime?.restartPending ?? false,
        reconnectAttempts: runtime?.reconnectAttempts ?? 0,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        healthState: runtime?.healthState ?? "stopped",
        supervisorState:
          (readRuntimeExtraUnknown(runtimeExtra, "supervisorState") as string | undefined) ??
          "stopped",
        receiveTransport: readRuntimeExtraUnknown(runtimeExtra, "receiveTransport") ?? null,
        supervisionRestarts:
          readRuntimeExtraNumber(runtimeExtra, "supervisionRestarts", 0) ?? 0,
        managedDaemon: readRuntimeExtraBool(
          runtimeExtra,
          "managedDaemon",
          resolveSignalEffectiveAutoStart(account.config),
        ),
      },
    };
  },
});

export const signalCustomGatewayAdapter: NonNullable<
  ChannelPlugin<ResolvedSignalAccount>["gateway"]
> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    ctx.setStatus({
      accountId: account.accountId,
      baseUrl: account.baseUrl,
      healthState: "starting",
    });
    ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
    return monitorSignalProvider({
      accountId: account.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      mediaMaxMb: account.config.mediaMaxMb,
      setStatus: (patch) =>
        ctx.setStatus({ accountId: account.accountId, ...(patch as Record<string, unknown>) } as never),
    });
  },
};

export const signalCustomSecurityAdapter: NonNullable<
  ChannelPlugin<ResolvedSignalAccount>["security"]
> = {
  resolveDmPolicy: ({ cfg, accountId, account }) => {
    const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
    const useAccountPath = Boolean(getSignalConfig(cfg)?.accounts?.[resolvedAccountId]);
    const basePath = useAccountPath
      ? `channels.${SIGNAL_CHANNEL_ID}.accounts.${resolvedAccountId}.`
      : `channels.${SIGNAL_CHANNEL_ID}.`;
    return {
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: `${basePath}dmPolicy`,
      allowFromPath: basePath,
      approveHint: formatPairingApproveHint(SIGNAL_CHANNEL_ID),
      normalizeEntry: (raw) => normalizeSignalAllowlistEntry(raw),
    };
  },
  collectWarnings: ({ account, cfg }) => {
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: getSignalConfig(cfg) !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
    if (groupPolicy !== "open") {
      return [];
    }
    return [
      `- Signal groups: groupPolicy="open" allows any member to trigger the bot. Set channels.${SIGNAL_CHANNEL_ID}.groupPolicy="allowlist" + channels.${SIGNAL_CHANNEL_ID}.groupAllowFrom to restrict senders.`,
    ];
  },
};

export function createSignalCustomPluginBase(): Pick<
  ChannelPlugin<ResolvedSignalAccount, SignalProbe>,
  | "id"
  | "meta"
  | "agentPrompt"
  | "setupWizard"
  | "capabilities"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "allowlist"
  | "security"
  | "setup"
  | "status"
  | "gateway"
> {
  return {
    ...createChannelPluginBase({
      id: SIGNAL_CHANNEL_ID,
      meta: SIGNAL_META,
      setupWizard: signalCustomSetupWizard,
      agentPrompt: {
        messageToolHints: () => [
          "- Signal supports message edits, reactions, stickers, polls, mentions, view-once media, and story replies.",
          "- For Signal view-once media, set `channelData.signal.viewOnce=true` on the reply payload.",
          "- For Signal story replies, set `channelData.signal.storyReply={ storyTimestamp, storyAuthor }` on the reply payload.",
          "- For deterministic Signal mentions, include `channelData.signal.mentions` ranges instead of relying only on plain text.",
        ],
      },
      capabilities: {
        chatTypes: ["direct", "group"],
        polls: true,
        media: true,
        reactions: true,
        edit: true,
        unsend: true,
        groupManagement: true,
        blockStreaming: true,
      },
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
      },
      reload: { configPrefixes: [`channels.${SIGNAL_CHANNEL_ID}`] },
      configSchema: buildChannelConfigSchema(SignalConfigSchema),
      config: {
        ...signalCustomConfigAdapter,
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          baseUrl: account.baseUrl,
        }),
      },
      security: signalCustomSecurityAdapter,
      setup: signalSetupAdapter,
    }),
    allowlist: signalCustomAllowlistAdapter,
    status: signalCustomStatusAdapter,
    gateway: signalCustomGatewayAdapter,
  } as Pick<
    ChannelPlugin<ResolvedSignalAccount, SignalProbe>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "allowlist"
    | "security"
    | "setup"
    | "status"
    | "gateway"
  >;
}
