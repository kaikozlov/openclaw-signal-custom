import { describe, expect, it, vi } from "vitest";
import { createSignalGatewaySupervisor } from "./gateway-supervisor.js";

describe("signal gateway supervisor", () => {
  it("publishes lifecycle status transitions", async () => {
    const setStatus = vi.fn();
    const supervisor = createSignalGatewaySupervisor({
      accountId: "default",
      runtime: { log: () => {}, error: () => {}, exit: () => {} },
      setStatus,
      managedDaemon: true,
      connectionMode: "managed-http",
      supervision: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
        maxAttempts: 2,
        drainGraceMs: 0,
      },
    });

    supervisor.markStarting("jsonrpc-poll");
    supervisor.markConnected("jsonrpc-poll");
    await supervisor.markStopping();
    supervisor.markStopped();

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        supervisorState: "starting",
        healthState: "starting",
        managedDaemon: true,
        connectionMode: "managed-http",
      }),
    );
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        supervisorState: "running",
        connected: true,
        healthState: "healthy",
        receiveTransport: "jsonrpc-poll",
      }),
    );
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        supervisorState: "stopped",
        running: false,
        connected: false,
        healthState: "stopped",
      }),
    );
  });

  it("schedules recoverable restarts and stops on permanent failures", async () => {
    const setStatus = vi.fn();
    const runtimeLog = vi.fn();
    const supervisor = createSignalGatewaySupervisor({
      accountId: "default",
      runtime: { log: runtimeLog, error: () => {}, exit: () => {} },
      setStatus,
      managedDaemon: false,
      connectionMode: "external-http",
      supervision: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
        maxAttempts: 2,
        drainGraceMs: 0,
      },
    });

    await expect(supervisor.waitBeforeRestart(new Error("connection lost"), 1)).resolves.toBe(true);
    await expect(
      supervisor.waitBeforeRestart({ status: 401, message: "unauthorized" }, 1),
    ).resolves.toBe(false);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("Signal gateway supervisor failed (connection lost); retrying in 0.000s"),
    );
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        supervisorState: "restarting",
        restartPending: true,
        reconnectAttempts: 1,
      }),
    );
  });
});
