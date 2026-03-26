import { describe, expect, it } from "vitest";
import { inspectSignalAccount } from "./account-inspect.js";

describe("inspectSignalAccount", () => {
  it("reports managed daemon defaults", () => {
    const inspected = inspectSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            cliPath: "signal-cli",
          },
        },
      } as never,
      accountId: "default",
    });

    expect(inspected).toEqual(
      expect.objectContaining({
        connectionMode: "managed-http",
        transportSummary: "managed HTTP daemon",
        effectiveAutoStart: true,
        configPathSet: false,
        attachmentFastPathLikely: true,
        receiveMode: "on-start",
        directoryRefreshTtlMs: 300000,
        reconnectMaxAttempts: 6,
        supervisionMaxRestarts: 8,
        supervisionDrainGraceMs: 2500,
      }),
    );
  });

  it("reports external daemon transport with degraded attachment fast path when configPath is missing", () => {
    const inspected = inspectSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            httpUrl: "http://signal.example:8080",
          },
        },
      } as never,
      accountId: "default",
    });

    expect(inspected).toEqual(
      expect.objectContaining({
        connectionMode: "external-http",
        transportSummary: "external HTTP daemon",
        effectiveAutoStart: false,
        configPathSet: false,
        attachmentFastPathLikely: false,
      }),
    );
  });

  it("treats configPath as restoring likely attachment fast path for external mode", () => {
    const inspected = inspectSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            httpUrl: "http://signal.example:8080",
            configPath: "/var/lib/signal-cli",
            autoStart: true,
            receiveMode: "manual",
          },
        },
      } as never,
      accountId: "default",
    });

    expect(inspected).toEqual(
      expect.objectContaining({
        effectiveAutoStart: true,
        configPathSet: true,
        attachmentFastPathLikely: true,
        receiveMode: "manual",
        directoryRefreshTtlMs: 300000,
        reconnectMaxAttempts: 6,
        supervisionMaxRestarts: 8,
        supervisionDrainGraceMs: 2500,
      }),
    );
  });

  it("reports configured directory refresh TTL overrides", () => {
    const inspected = inspectSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15551234567",
            directoryRefreshTtlMs: 15000,
          },
        },
      } as never,
      accountId: "default",
    });

    expect(inspected.directoryRefreshTtlMs).toBe(15000);
  });
});
