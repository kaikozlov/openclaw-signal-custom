import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSignalSocketRegistryForTests,
  SignalHttpError,
  SignalNetworkError,
  SignalRpcError,
  signalRpcRequest,
  signalRpcRequestWithRetry,
} from "./client.js";

function makeResponse(params: {
  status?: number;
  ok?: boolean;
  statusText?: string;
  text: string;
}): Response {
  return {
    status: params.status ?? 200,
    ok: params.ok ?? true,
    statusText: params.statusText ?? "OK",
    text: async () => params.text,
  } as Response;
}

describe("signal client typed errors and retry", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetSignalSocketRegistryForTests();
  });

  it("throws SignalRpcError for JSON-RPC errors", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "boom" },
        }),
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalRpcError);
  });

  it("throws SignalHttpError for non-2xx responses", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 503,
        ok: false,
        statusText: "Service Unavailable",
        text: "unavailable",
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalHttpError);
  });

  it("throws SignalNetworkError for malformed RPC envelopes", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
        }),
      }),
    );

    await expect(
      signalRpcRequest("send", { recipient: ["+15550001111"] }, { baseUrl: "http://signal.local" }),
    ).rejects.toBeInstanceOf(SignalNetworkError);
  });

  it("retries recoverable timeouts with backoff", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("request timeout"))
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000000001 },
          }),
        }),
      );

    const result = await signalRpcRequestWithRetry<{ timestamp: number }>(
      "send",
      { recipient: ["+15550001111"], message: "hi" },
      {
        baseUrl: "http://signal.local",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    );

    expect(result.timestamp).toBe(1700000000001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes RPC through socket client when connected", async () => {
    const socketRequest = vi.fn(async () => ({ timestamp: 1700000000002 }));
    const socketClient = {
      isConnected: true,
      request: socketRequest,
      connect: vi.fn(),
      close: vi.fn(),
    } as unknown as import("./socket-client.js").SignalSocketClient;

    const result = await signalRpcRequest("send", { message: "hi" }, {
      baseUrl: "http://signal.local",
      socketClient,
    });

    expect(result).toEqual({ timestamp: 1700000000002 });
    expect(socketRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to HTTP when socket request fails", async () => {
    const socketRequest = vi.fn(async () => {
      throw new Error("connection lost");
    });
    const socketClient = {
      isConnected: true,
      request: socketRequest,
      connect: vi.fn(),
      close: vi.fn(),
    } as unknown as import("./socket-client.js").SignalSocketClient;

    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000003 },
        }),
      }),
    );

    const result = await signalRpcRequest("send", { message: "hi" }, {
      baseUrl: "http://signal.local",
      socketClient,
    });

    expect(socketRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ timestamp: 1700000000003 });
  });
});
