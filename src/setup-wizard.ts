import {
  createCliPathTextInput,
  createDetectedBinaryStatus,
  formatCliCommand,
  formatDocsLink,
  normalizeE164,
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { detectBinary, installSignalCli } from "openclaw/plugin-sdk/setup-tools";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./runtime-api.js";
import {
  getSignalConfig,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID } from "./constants.js";
import {
  inspectSignalAccount,
  resolveSignalTransportSummary,
} from "./signal/account-inspect.js";
import { normalizeSignalAllowlistEntry } from "./signal/allowlist.js";

const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
const INVALID_HTTP_URL_ERROR = "Invalid URL (must start with http:// or https://)";
const INVALID_HTTP_PORT_ERROR = "Invalid HTTP port";

export function normalizeSignalCustomAccountInput(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

export function parseSignalCustomAllowFromEntries(raw: string): {
  entries: string[];
  error?: string;
} {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const normalized = normalizeSignalAllowlistEntry(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

async function promptSignalCustomAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return await promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "Signal allowlist",
    noteLines: [
      "Allowlist Signal DMs by sender id.",
      "Examples:",
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/channels/signal", "signal")}`,
    ],
    message: "Signal allowFrom (E.164 or uuid)",
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    parseEntries: parseSignalCustomAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel: SIGNAL_CHANNEL_ID as never,
        accountId,
        allowFrom,
      }),
  });
}

export const signalCustomDmPolicy: ChannelSetupDmPolicy = {
  label: "Signal Custom",
  channel: SIGNAL_CHANNEL_ID as never,
  policyKey: `channels.${SIGNAL_CHANNEL_ID}.dmPolicy`,
  allowFromKey: `channels.${SIGNAL_CHANNEL_ID}.allowFrom`,
  getCurrent: (cfg: OpenClawConfig) => cfg.channels?.[SIGNAL_CHANNEL_ID]?.dmPolicy ?? "pairing",
  setPolicy: (cfg: OpenClawConfig, policy) =>
    setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: SIGNAL_CHANNEL_ID as never,
      dmPolicy: policy,
    }),
  promptAllowFrom: promptSignalCustomAllowFrom,
};

function resolveSignalCustomCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
    "signal-cli"
  );
}

function createSignalCustomCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return createCliPathTextInput({
    inputKey: "cliPath",
    message: "signal-cli path",
    resolvePath: ({ cfg, accountId, credentialValues }) =>
      resolveSignalCustomCliPath({ cfg, accountId, credentialValues }),
    shouldPrompt,
    helpTitle: "Signal Custom",
    helpLines: [
      `signal-cli not found. Install it, then rerun this step or set channels.${SIGNAL_CHANNEL_ID}.cliPath.`,
    ],
  });
}

function validateSignalHttpUrlInput(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return INVALID_HTTP_URL_ERROR;
    }
    return undefined;
  } catch {
    return INVALID_HTTP_URL_ERROR;
  }
}

function validateSignalHttpPortInput(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return INVALID_HTTP_PORT_ERROR;
  }
  return undefined;
}

function patchSignalCustomAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [SIGNAL_CHANNEL_ID]: {
          ...params.cfg.channels?.[SIGNAL_CHANNEL_ID],
          ...params.patch,
        },
      },
    };
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [SIGNAL_CHANNEL_ID]: {
        ...params.cfg.channels?.[SIGNAL_CHANNEL_ID],
        accounts: {
          ...getSignalConfig(params.cfg)?.accounts,
          [accountId]: {
            ...getSignalConfig(params.cfg)?.accounts?.[accountId],
            ...params.patch,
          },
        },
      },
    },
  };
}

export function collectSignalCustomSetupWarnings(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string[] {
  const inspected = inspectSignalAccount(params);
  const warnings: string[] = [];
  if ((inspected.config.dmPolicy ?? "pairing") === "open") {
    warnings.push('DM policy is open. Any Signal DM sender can trigger the bot.');
  }
  if (
    (inspected.config.dmPolicy ?? "pairing") === "allowlist" &&
    (inspected.config.allowFrom ?? []).length === 0
  ) {
    warnings.push('DM policy is allowlist, but no DM allowlist entries are configured yet.');
  }
  if ((inspected.config.groupPolicy ?? "allowlist") === "open") {
    warnings.push('Group policy is open. Any group member can trigger the bot.');
  }
  if (inspected.connectionMode !== "external-http" && inspected.effectiveAutoStart === false) {
    warnings.push(
      "Managed Signal transport has autoStart disabled. The gateway will not receive messages until signal-cli is started separately.",
    );
  }
  if (inspected.connectionMode === "external-http" && !inspected.configPathSet) {
    warnings.push(
      "External HTTP mode has no configPath. Attachment fetches will fall back to RPC instead of the local signal-cli attachment store.",
    );
  }
  return warnings;
}

async function maybePromptSignalCustomConfigPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const inspected = inspectSignalAccount(params);
  if (inspected.connectionMode === "external-http" || inspected.configPathSet) {
    return params.cfg;
  }
  const wantsConfigPath = await params.prompter.confirm({
    message: "Set a custom signal-cli config path now?",
    initialValue: false,
  });
  if (!wantsConfigPath) {
    return params.cfg;
  }
  const configPath = (await params.prompter.text({
    message: "signal-cli config path",
    placeholder: "/var/lib/signal-cli",
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  })).trim();
  return patchSignalCustomAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { configPath },
  });
}

async function maybePromptSignalCustomExternalDaemon(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const inspected = inspectSignalAccount(params);
  if (inspected.connectionMode === "external-http") {
    return params.cfg;
  }
  const wantsExternalDaemon = await params.prompter.confirm({
    message: "Use an already-running external Signal daemon instead of managed local mode?",
    initialValue: false,
  });
  if (!wantsExternalDaemon) {
    return params.cfg;
  }
  const httpUrl = (await params.prompter.text({
    message: "Signal external daemon URL",
    placeholder: "http://127.0.0.1:8080",
    validate: (value) => validateSignalHttpUrlInput(value),
  })).trim();
  return patchSignalCustomAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { httpUrl },
  });
}

async function maybePromptSignalCustomReactionDelivery(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const current =
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.reactionDelivery ??
    "queue";
  const immediate = await params.prompter.confirm({
    message: "Wake the model immediately when a Signal reaction arrives?",
    initialValue: current === "immediate",
  });
  const nextMode = immediate ? "immediate" : "queue";
  if (nextMode === current) {
    return params.cfg;
  }
  return patchSignalCustomAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { reactionDelivery: nextMode },
  });
}

export const signalCustomNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: "Signal bot number (E.164)",
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalCustomAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  keepPrompt: (value) => `Signal account set (${value}). Keep it?`,
  validate: ({ value }) =>
    normalizeSignalCustomAccountInput(value) ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
  normalizeValue: ({ value }) => normalizeSignalCustomAccountInput(value) ?? value,
};

const signalCustomHttpUrlTextInput: ChannelSetupWizardTextInput = {
  inputKey: "httpUrl",
  message: "Signal external daemon URL",
  placeholder: "http://127.0.0.1:8080",
  helpTitle: "Signal transport",
  helpLines: [
    "Set this only when you already run a separate signal-cli REST daemon.",
    "Leave it unset for the default managed local daemon mode.",
  ],
  currentValue: ({ cfg, accountId }) =>
    resolveSignalAccount({ cfg, accountId }).config.httpUrl?.trim() || undefined,
  keepPrompt: (value) => `External Signal daemon URL set (${value}). Keep it?`,
  shouldPrompt: ({ currentValue }) => Boolean(currentValue?.trim()),
  validate: ({ value }) => validateSignalHttpUrlInput(value),
  normalizeValue: ({ value }) => String(value).trim(),
};

const signalCustomHttpHostTextInput: ChannelSetupWizardTextInput = {
  inputKey: "httpHost",
  message: "Managed Signal daemon host",
  placeholder: "127.0.0.1",
  currentValue: ({ cfg, accountId }) =>
    resolveSignalAccount({ cfg, accountId }).config.httpHost?.trim() || undefined,
  keepPrompt: (value) => `Managed Signal daemon host set (${value}). Keep it?`,
  shouldPrompt: ({ currentValue }) => Boolean(currentValue?.trim()),
  validate: ({ value }) =>
    String(value ?? "").trim() ? undefined : "Managed daemon host cannot be empty",
  normalizeValue: ({ value }) => String(value).trim(),
};

const signalCustomHttpPortTextInput: ChannelSetupWizardTextInput = {
  inputKey: "httpPort",
  message: "Managed Signal daemon port",
  placeholder: "8080",
  currentValue: ({ cfg, accountId }) => {
    const value = resolveSignalAccount({ cfg, accountId }).config.httpPort;
    return typeof value === "number" ? String(value) : undefined;
  },
  keepPrompt: (value) => `Managed Signal daemon port set (${value}). Keep it?`,
  shouldPrompt: ({ currentValue }) => Boolean(currentValue?.trim()),
  validate: ({ value }) => validateSignalHttpPortInput(value),
  normalizeValue: ({ value }) => String(value).trim(),
};

export const signalCustomIntroNote = {
  title: "Signal transport modes",
  lines: [
    "Managed mode: leave httpUrl unset. OpenClaw will talk to a local signal-cli daemon and autostart it by default.",
    "External mode: set httpUrl. OpenClaw will use an already-running signal-cli daemon unless you explicitly enable autoStart.",
    "Reaction delivery: queue keeps reaction system events for the next real run; immediate wakes the model right away with the same event text.",
  ],
};

export const signalCustomCompletionNote = {
  title: "Signal next steps",
  lines: [
    'Link device with: signal-cli link -n "OpenClaw"',
    "Scan QR in Signal -> Linked Devices",
    "Managed mode autostarts the local daemon by default. External mode expects an already-running daemon unless autoStart=true.",
    "Set configPath when you need a non-default signal-cli profile directory or better local attachment lookup diagnostics.",
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/channels/signal", "signal")}`,
  ],
};

export const signalCustomSetupWizard: ChannelSetupWizard = {
  channel: SIGNAL_CHANNEL_ID as never,
  introNote: signalCustomIntroNote,
  status: createDetectedBinaryStatus({
    channelLabel: "Signal Custom",
    binaryLabel: "signal-cli",
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "signal-cli found",
    unconfiguredHint: "signal-cli missing",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listSignalAccountIds(cfg).some(
        (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
      ),
    resolveBinaryPath: ({ cfg }) =>
      resolveSignalAccount({
        cfg,
        accountId: resolveDefaultSignalAccountId(cfg),
      }).config.cliPath ?? "signal-cli",
    detectBinary,
  }),
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return;
    }
    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg, accountId }).config.cliPath ??
      "signal-cli";
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await prompter.confirm({
      message: cliDetected
        ? "signal-cli detected. Reinstall/update now?"
        : "signal-cli not found. Install now?",
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return;
    }
    try {
      const result = await installSignalCli(runtime);
      if (result.ok && result.cliPath) {
        await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal Custom");
        return {
          credentialValues: {
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await prompter.note(result.error ?? "signal-cli install failed.", "Signal Custom");
      }
    } catch (error) {
      await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal Custom");
    }
  },
  credentials: [],
  textInputs: [
    createSignalCustomCliPathTextInput(async ({ currentValue }) => {
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalCustomNumberTextInput,
    signalCustomHttpUrlTextInput,
    signalCustomHttpHostTextInput,
    signalCustomHttpPortTextInput,
  ],
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = await maybePromptSignalCustomExternalDaemon({ cfg, accountId, prompter });
    next = await maybePromptSignalCustomConfigPath({ cfg: next, accountId, prompter });
    next = await maybePromptSignalCustomReactionDelivery({ cfg: next, accountId, prompter });
    const inspected = inspectSignalAccount({ cfg: next, accountId });
    const warnings = collectSignalCustomSetupWarnings({ cfg: next, accountId });
    if (warnings.length > 0) {
      await prompter.note(warnings.join("\n"), "Signal Custom warnings");
    } else {
      await prompter.note(
        `Configured ${resolveSignalTransportSummary(inspected.config)} (${inspected.baseUrl}).`,
        "Signal Custom transport",
      );
    }
    return next === cfg ? undefined : { cfg: next };
  },
  completionNote: signalCustomCompletionNote,
  dmPolicy: signalCustomDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, SIGNAL_CHANNEL_ID as never, false),
};
