import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { monitorSignalProviderMock, sendMessageSignalMock } = vi.hoisted(() => ({
  monitorSignalProviderMock: vi.fn(),
  sendMessageSignalMock: vi.fn(),
}));

vi.mock("./signal/monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./signal/monitor.js")>("./signal/monitor.js");
  return {
    ...actual,
    monitorSignalProvider: (...args: Parameters<typeof actual.monitorSignalProvider>) =>
      monitorSignalProviderMock(...args),
  };
});

vi.mock("./signal/send.js", async () => {
  const actual = await vi.importActual<typeof import("./signal/send.js")>("./signal/send.js");
  return {
    ...actual,
    sendMessageSignal: (...args: Parameters<typeof actual.sendMessageSignal>) =>
      sendMessageSignalMock(...args),
  };
});

import { signalPlugin } from "./channel.js";

describe("signal plugin shell modernization", () => {
  beforeEach(() => {
    monitorSignalProviderMock.mockReset();
    sendMessageSignalMock.mockReset();
  });

  it("keeps runtime-api on public SDK subpaths", () => {
    const runtimeApiPath = resolve(import.meta.dirname, "runtime-api.ts");
    const source = readFileSync(runtimeApiPath, "utf8");

    expect(source).not.toContain(`openclaw/plugin-sdk/signal"`);
    expect(source).not.toContain(`openclaw/plugin-sdk/signal'`);
  });

  it("exposes config-backed DM/group allowlist editing surfaces", async () => {
    const allowlist = signalPlugin.allowlist;
    expect(allowlist?.supportsScope?.({ scope: "dm" })).toBe(true);
    expect(allowlist?.supportsScope?.({ scope: "group" })).toBe(true);
    expect(allowlist?.supportsScope?.({ scope: "all" })).toBe(true);

    const cfg = {
      channels: {
        "signal-custom": {
          dmPolicy: "allowlist",
          allowFrom: ["signal:+15550001111"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550002222"],
        },
      },
    } as never;

    expect(await allowlist?.readConfig?.({ cfg })).toEqual({
      dmPolicy: "allowlist",
      dmAllowFrom: ["signal:+15550001111"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15550002222"],
      groupOverrides: [],
    });
  });

  it("builds status snapshots and summaries through the shared adapter", async () => {
    const account = {
      accountId: "work",
      enabled: true,
      configured: true,
      name: "Work",
      baseUrl: "http://signal.local",
      config: {},
    };

    const snapshot = await signalPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg: {} as never,
      runtime: {
        accountId: "work",
        running: true,
        connected: true,
        restartPending: false,
        reconnectAttempts: 0,
        lastConnectedAt: 9,
        lastDisconnect: null,
        healthState: "healthy",
        supervisorState: "running",
        receiveTransport: "sse",
        supervisionRestarts: 0,
        managedDaemon: true,
        lastStartAt: 10,
        lastStopAt: null,
        lastError: null,
        lastInboundAt: 11,
        lastOutboundAt: 12,
      } as never,
      probe: { ok: true, elapsedMs: 1, version: "1.0.0" },
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        accountId: "work",
        running: true,
        connected: true,
        lastInboundAt: 11,
        lastOutboundAt: 12,
        healthState: "healthy",
      }),
    );

    const summary = await signalPlugin.status?.buildChannelSummary?.({
      account,
      cfg: {} as never,
      defaultAccountId: "default",
      snapshot: {
        accountId: "work",
        configured: true,
        running: false,
        connected: false,
        restartPending: false,
        reconnectAttempts: 0,
        healthState: "stopped",
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: null,
        baseUrl: "http://signal.local",
        probe: { ok: true, elapsedMs: 1, version: "1.0.0" },
        lastProbeAt: 20,
      } as never,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        configured: true,
        running: false,
        baseUrl: "http://signal.local",
        connected: false,
        healthState: "stopped",
        lastProbeAt: 20,
      }),
    );
  });

  it("routes pairing approvals through the text pairing adapter", async () => {
    sendMessageSignalMock.mockResolvedValueOnce({ messageId: "m1" });
    const cfg = { channels: { "signal-custom": { account: "+15550001111" } } } as never;

    await signalPlugin.pairing?.notifyApproval?.({
      cfg,
      id: "+15550002222",
    });

    expect(sendMessageSignalMock).toHaveBeenCalledWith(
      "+15550002222",
      "✅ OpenClaw access approved. Send a message to start chatting.",
      { cfg },
    );
  });

  it("starts the provider through the shared gateway adapter", async () => {
    monitorSignalProviderMock.mockResolvedValueOnce(Symbol("gateway-stop"));
    const setStatus = vi.fn();
    const logInfo = vi.fn();

    const result = await signalPlugin.gateway?.startAccount?.({
      cfg: {} as never,
      accountId: "work",
      account: {
        accountId: "work",
        baseUrl: "http://signal.local",
        config: { mediaMaxMb: 16 },
      } as never,
      runtime: {} as never,
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: "work" } as never),
      setStatus,
      log: { info: logInfo } as never,
    });

    expect(setStatus).toHaveBeenCalledWith({
      accountId: "work",
      baseUrl: "http://signal.local",
      healthState: "starting",
    });
    expect(logInfo).toHaveBeenCalledWith(`[work] starting provider (http://signal.local)`);
    expect(monitorSignalProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        mediaMaxMb: 16,
        setStatus: expect.any(Function),
      }),
    );
    expect(typeof result).toBe("symbol");
  });
});
