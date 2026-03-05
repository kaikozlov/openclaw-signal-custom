import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySignalCliLogLine } from "./daemon.js";
import { probeSignal } from "./probe.js";

const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();

vi.mock("./client.js", () => ({
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

describe("probeSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts version from object results", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    const result = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.13.22");
    expect(result.status).toBe(200);
  });

  it("returns ok=true when /check fails but JSON-RPC version succeeds", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "HTTP 404",
    });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.24" });

    const result = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(null);
    expect(result.version).toBe("0.13.24");
  });

  it("returns ok=false when both /check and JSON-RPC fail", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });
    signalRpcRequestMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.version).toBe(null);
    expect(result.error).toBe("HTTP 503");
  });

  it("returns ok=true with error when /check passes but JSON-RPC fails", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    signalRpcRequestMock.mockRejectedValueOnce(new Error("rpc timeout"));

    const result = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.version).toBe(null);
    expect(result.error).toBe("rpc timeout");
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats info-like lines as log output", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats warnings and errors as errors", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats untagged failures as errors", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});
