import { describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";
import {
  normalizeSignalCustomAccountInput,
  parseSignalCustomAllowFromEntries,
  signalCustomSetupWizard,
} from "./setup-wizard.js";

describe("signal custom setup wizard", () => {
  it("normalizes valid E.164 numbers and rejects invalid input", () => {
    expect(normalizeSignalCustomAccountInput("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeSignalCustomAccountInput("not-a-number")).toBeNull();
  });

  it("parses wildcard, phone, and uuid allowlist entries", () => {
    expect(
      parseSignalCustomAllowFromEntries(
        "*, +15551234567, 123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toEqual({
      entries: ["*", "+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("is wired onto the plugin with validated phone-number input", () => {
    expect(signalPlugin.setupWizard).toBe(signalCustomSetupWizard);
    expect(signalCustomSetupWizard.channel).toBe("signal-custom");

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
});
