import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { classifySignalCliLogLine, spawnSignalDaemon } from "./daemon.js";

function createChildProcessMock() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    pid: number;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 12345;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("classifySignalCliLogLine", () => {
  it("treats info and debug lines as log output", () => {
    expect(classifySignalCliLogLine("[main] INFO org.asamk.signal.Main - starting")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG org.asamk.signal.Main")).toBe("log");
  });

  it("treats warnings and failures as errors", () => {
    expect(classifySignalCliLogLine("WARN something happened")).toBe("error");
    expect(classifySignalCliLogLine("Exception in thread")).toBe("error");
  });

  it("ignores blank lines", () => {
    expect(classifySignalCliLogLine("   ")).toBeNull();
  });
});

describe("spawnSignalDaemon", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createChildProcessMock());
  });

  it("passes configPath through to signal-cli as --config", () => {
    spawnSignalDaemon({
      cliPath: "signal-cli",
      configPath: "/tmp/signal-cli",
      account: "+15550001111",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "signal-cli",
      [
        "--config",
        "/tmp/signal-cli",
        "-a",
        "+15550001111",
        "daemon",
        "--http",
        "127.0.0.1:8080",
        "--no-receive-stdout",
      ],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("rejects unsafe cliPath values before spawning", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "signal-cli; rm -rf /",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid signal-cli path/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects flag-injection cliPath values before spawning", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "-malicious",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid signal-cli path/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
