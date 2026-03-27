import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import {
  collectSignalCustomSetupWarnings,
  normalizeSignalCustomAccountInput,
  parseSignalCustomAllowFromEntries,
  signalCustomSetupWizard,
} from "./setup-wizard.js";
import { resolveSignalAccount } from "./config.js";
import { signalCustomStatusAdapter } from "./shared.js";

function createWizardPrompter(overrides?: {
  confirm?: Array<boolean>;
  text?: Array<string>;
}) {
  const confirmQueue = [...(overrides?.confirm ?? [])];
  const textQueue = [...(overrides?.text ?? [])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => null),
    multiselect: vi.fn(async () => []),
    progress: vi.fn(() => ({ update: () => {}, stop: () => {} })),
    confirm: vi.fn(async () => confirmQueue.shift() ?? false),
    text: vi.fn(async () => textQueue.shift() ?? ""),
  };
}

describe("signal custom setup wizard", () => {
  it("normalizes valid E.164 numbers and rejects invalid input", () => {
    expect(normalizeSignalCustomAccountInput("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeSignalCustomAccountInput("not-a-number")).toBeNull();
  });

  it("parses wildcard, phone, and uuid allowlist entries", () => {
    expect(
      parseSignalCustomAllowFromEntries(
        "*, +15551234567, uuid:123E4567-E89B-12D3-A456-426614174000, 123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toEqual({
      entries: [
        "*",
        "+15551234567",
        "uuid:123e4567-e89b-12d3-a456-426614174000",
      ],
    });
  });

  it("rejects invalid uuid allowlist entries", () => {
    expect(parseSignalCustomAllowFromEntries("uuid:not-a-uuid")).toEqual({
      entries: [],
      error: "Invalid entry: uuid:not-a-uuid",
    });
    expect(parseSignalCustomAllowFromEntries("not-a-uuid")).toEqual({
      entries: [],
      error: "Invalid entry: not-a-uuid",
    });
  });

  it("is wired onto the plugin with validated phone-number input", () => {
    expect(signalPlugin.setupWizard).toBe(signalCustomSetupWizard);
    expect(signalCustomSetupWizard.channel).toBe("signal-custom");
    expect(signalCustomSetupWizard.introNote?.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Managed mode"),
        expect.stringContaining("External mode"),
        expect.stringContaining("Reaction delivery"),
      ]),
    );

    if (!signalCustomSetupWizard.textInputs) {
      throw new Error("missing signal setup inputs");
    }
    const numberInput = signalCustomSetupWizard.textInputs[1];
    if (!numberInput) {
      throw new Error("missing signal number setup input");
    }

    expect(
      numberInput.validate?.({
        value: "not-a-number",
        cfg: {} as never,
        accountId: "default",
        credentialValues: {},
      }),
    ).toMatch(/Invalid E\.164/);
    expect(
      numberInput.normalizeValue?.({
        value: "+1 (555) 123-4567",
        cfg: {} as never,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe("+15551234567");
  });

  it("exposes optional transport inputs for existing custom daemon settings", () => {
    const httpUrlInput = signalCustomSetupWizard.textInputs?.find(
      (input) => input.inputKey === "httpUrl",
    );
    const httpHostInput = signalCustomSetupWizard.textInputs?.find(
      (input) => input.inputKey === "httpHost",
    );
    const httpPortInput = signalCustomSetupWizard.textInputs?.find(
      (input) => input.inputKey === "httpPort",
    );

    expect(httpUrlInput?.currentValue?.({
      cfg: {
        channels: {
          "signal-custom": {
            httpUrl: "http://signal.example:8080",
          },
        },
      } as never,
      accountId: "default",
      credentialValues: {},
    })).toBe("http://signal.example:8080");
    expect(
      httpUrlInput?.validate?.({
        value: "bad-url",
        cfg: {} as never,
        accountId: "default",
        credentialValues: {},
      }),
    ).toMatch(/Invalid URL/);
    expect(httpHostInput?.currentValue?.({
      cfg: {
        channels: {
          "signal-custom": {
            httpHost: "0.0.0.0",
          },
        },
      } as never,
      accountId: "default",
      credentialValues: {},
    })).toBe("0.0.0.0");
    expect(
      httpPortInput?.validate?.({
        value: "70000",
        cfg: {} as never,
        accountId: "default",
        credentialValues: {},
      }),
    ).toMatch(/Invalid HTTP port/);
  });

  it("collects setup warnings for permissive or degraded transport configs", () => {
    expect(
      collectSignalCustomSetupWarnings({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15551234567",
              httpUrl: "http://signal.example:8080",
              dmPolicy: "open",
            },
          },
        } as never,
        accountId: "default",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DM policy is open"),
        expect.stringContaining("no configPath"),
      ]),
    );
  });

  it("finalize can switch to external mode and persist a managed configPath", async () => {
    if (!signalCustomSetupWizard.finalize) {
      throw new Error("missing signal finalize step");
    }
    const prompter = createWizardPrompter({
      confirm: [true, false, false],
      text: ["http://signal.example:8080"],
    });
    const finalized = await signalCustomSetupWizard.finalize({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            cliPath: "signal-cli",
          },
        },
      } as never,
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter: prompter as never,
      options: {},
      forceAllowFrom: false,
    });

    expect(
      resolveSignalAccount({
        cfg: finalized?.cfg ?? ({} as never),
        accountId: "default",
      }).config.httpUrl,
    ).toBe("http://signal.example:8080");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("no configPath"),
      "Signal Custom warnings",
    );
  });

  it("finalize can persist immediate reaction delivery", async () => {
    if (!signalCustomSetupWizard.finalize) {
      throw new Error("missing signal finalize step");
    }
    const prompter = createWizardPrompter({
      confirm: [false, false, true],
    });
    const finalized = await signalCustomSetupWizard.finalize({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            cliPath: "signal-cli",
          },
        },
      } as never,
      accountId: "default",
      credentialValues: {},
      runtime: {} as never,
      prompter: prompter as never,
      options: {},
      forceAllowFrom: false,
    });

    expect(
      resolveSignalAccount({
        cfg: finalized?.cfg ?? ({} as never),
        accountId: "default",
      }).config.reactionDelivery,
    ).toBe("immediate");
  });

  it("exposes reaction delivery in the computed status snapshot", () => {
    const account = resolveSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            reactionDelivery: "immediate",
          },
        },
      } as never,
      accountId: "default",
    });

    const snapshot = signalCustomStatusAdapter.buildAccountSnapshot?.({
      account,
      runtime: null,
      probe: null,
      audit: null,
    } as never);

    expect(snapshot).toEqual(
      expect.objectContaining({
        reactionDelivery: "immediate",
        reactionDeliveryStatus: "reaction delivery: immediate",
      }),
    );
  });
});
