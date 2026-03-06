import { describe, expect, it } from "vitest";
import { isSignalSenderAllowed, resolveSignalSender } from "./identity.js";

describe("resolveSignalSender", () => {
  it("returns phone sender with uuid when both sourceNumber and sourceUuid are present", () => {
    const sender = resolveSignalSender({
      sourceNumber: "+15550001111",
      sourceUuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
      uuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
  });

  it("falls back to the legacy source field when sourceNumber is absent", () => {
    const sender = resolveSignalSender({
      source: "+15550002222",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550002222",
      e164: "+15550002222",
      uuid: undefined,
    });
  });

  it("falls back to uuid sender when sourceNumber is absent", () => {
    const sender = resolveSignalSender({
      sourceUuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    });
  });
});

describe("isSignalSenderAllowed", () => {
  it("matches uuid allowlist entries against phone senders that carry uuid metadata", () => {
    const sender = {
      kind: "phone" as const,
      raw: "+15550001111",
      e164: "+15550001111",
      uuid: "cb274c30-17ce-49ee-97c6-55dd9ce14595",
    };
    expect(isSignalSenderAllowed(sender, ["uuid:cb274c30-17ce-49ee-97c6-55dd9ce14595"])).toBe(
      true,
    );
  });

  it("rejects uuid allowlist entries when phone senders have no uuid metadata", () => {
    const sender = {
      kind: "phone" as const,
      raw: "+15550001111",
      e164: "+15550001111",
    };
    expect(isSignalSenderAllowed(sender, ["uuid:cb274c30-17ce-49ee-97c6-55dd9ce14595"])).toBe(
      false,
    );
  });
});
