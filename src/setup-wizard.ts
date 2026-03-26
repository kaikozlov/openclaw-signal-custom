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
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID } from "./constants.js";

const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

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
    if (entry.toLowerCase().startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (UUID_LIKE_RE.test(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalCustomAccountInput(entry);
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

export const signalCustomCompletionNote = {
  title: "Signal next steps",
  lines: [
    'Link device with: signal-cli link -n "OpenClaw"',
    "Scan QR in Signal -> Linked Devices",
    `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
    `Docs: ${formatDocsLink("/channels/signal", "signal")}`,
  ],
};

export const signalCustomSetupWizard: ChannelSetupWizard = {
  channel: SIGNAL_CHANNEL_ID as never,
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
  ],
  completionNote: signalCustomCompletionNote,
  dmPolicy: signalCustomDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, SIGNAL_CHANNEL_ID as never, false),
};
