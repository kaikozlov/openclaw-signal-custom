import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeE164,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./config.js";
import { SIGNAL_CHANNEL_ID } from "./constants.js";

const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  if (!/^\+\d{5,15}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
}) {
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
  };
}

function setChannelEnabled(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [SIGNAL_CHANNEL_ID]: {
        ...cfg.channels?.[SIGNAL_CHANNEL_ID],
        enabled,
      },
    },
  };
}

export const signalOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: SIGNAL_CHANNEL_ID,
  getStatus: async ({ cfg }) => {
    const configured = listSignalAccountIds(cfg).some(
      (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
    );
    return {
      channel: SIGNAL_CHANNEL_ID,
      configured,
      statusLines: [`Signal Custom: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides[SIGNAL_CHANNEL_ID]?.trim();
    const defaultAccountId = resolveDefaultSignalAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Signal Custom",
        currentId: accountId,
        listAccountIds: listSignalAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveSignalAccount({ cfg, accountId });
    const existingAccount = normalizeSignalAccountInput(resolved.config.account ?? "");
    const keepExisting =
      existingAccount &&
      (await prompter.confirm({
        message: `Signal number set (${existingAccount}). Keep it?`,
        initialValue: true,
      }));

    const signalNumber = keepExisting
      ? existingAccount
      : normalizeSignalAccountInput(
          String(
            await prompter.text({
              message: "Signal bot number (E.164)",
              initialValue: existingAccount ?? "",
              validate: (value) =>
                normalizeSignalAccountInput(String(value ?? ""))
                  ? undefined
                  : INVALID_SIGNAL_ACCOUNT_ERROR,
            }),
          ),
        ) ?? "";

    const httpUrl = String(
      await prompter.text({
        message: "Signal daemon URL (optional; leave blank for local signal-cli)",
        initialValue: resolved.config.httpUrl ?? "",
      }),
    ).trim();
    const cliPath = String(
      await prompter.text({
        message: "signal-cli path",
        initialValue: resolved.config.cliPath ?? "signal-cli",
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    const patch = buildSignalSetupPatch({
      signalNumber,
      cliPath,
      httpUrl: httpUrl || undefined,
    });

    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        cfg: {
          ...cfg,
          channels: {
            ...cfg.channels,
            [SIGNAL_CHANNEL_ID]: {
              ...cfg.channels?.[SIGNAL_CHANNEL_ID],
              enabled: true,
              ...patch,
            },
          },
        },
        accountId,
      };
    }

    const currentChannel = cfg.channels?.[SIGNAL_CHANNEL_ID];
    const currentAccounts =
      currentChannel && typeof currentChannel === "object" && "accounts" in currentChannel
        ? (currentChannel.accounts as Record<string, unknown> | undefined)
        : undefined;

    return {
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          [SIGNAL_CHANNEL_ID]: {
            ...cfg.channels?.[SIGNAL_CHANNEL_ID],
            enabled: true,
            accounts: {
              ...currentAccounts,
              [accountId]: {
                ...(currentAccounts?.[accountId] as Record<string, unknown> | undefined),
                enabled: true,
                ...patch,
              },
            },
          },
        },
      },
      accountId,
    };
  },
  disable: (cfg) => setChannelEnabled(cfg, false),
};
