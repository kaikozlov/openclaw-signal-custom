import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSignalApiMode,
  pollSignalJsonRpc,
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

  it("detects SSE mode when /api/v1/events responds 200", async () => {
    const cancel = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: { cancel },
    } as unknown as Response);

    const mode = await detectSignalApiMode("http://signal.local");

    expect(mode).toBe("sse");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back to jsonrpc mode when /api/v1/events is unavailable", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: null,
    } as unknown as Response);

    await expect(detectSignalApiMode("http://signal.local")).resolves.toBe("jsonrpc");
  });

  it("polls JSON-RPC receive and converts envelopes into receive events", async () => {
    const events: Array<{ event?: string; data?: string }> = [];
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: [
            { envelope: { sourceNumber: "+15550001111", dataMessage: { message: "hello" } } },
            { envelope: { sourceNumber: "+15550002222", dataMessage: { message: "hi" } } },
          ],
        }),
      }),
    );

    await pollSignalJsonRpc({
      baseUrl: "http://signal.local",
      account: "+15559990000",
      onEvent: (event) => events.push(event),
      pollTimeoutSec: 1,
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(
      expect.objectContaining({
        event: "receive",
      }),
    );
    expect(JSON.parse(String(events[0]?.data))).toEqual(
      expect.objectContaining({
        envelope: expect.objectContaining({
          sourceNumber: "+15550001111",
        }),
      }),
    );
    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(request.params).toEqual(
      expect.objectContaining({
        account: "+15559990000",
        timeout: 1,
      }),
    );
  });

  it("falls back to receive without account when single-account daemons reject it", async () => {
    const events: Array<{ event?: string; data?: string }> = [];
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message:
                'Unrecognized field "account" (class org.asamk.signal.commands.ReceiveCommand$ReceiveParams)',
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: [{ envelope: { sourceNumber: "+15550001111", dataMessage: { message: "hello" } } }],
          }),
        }),
      );

    await pollSignalJsonRpc({
      baseUrl: "http://signal.local",
      account: "+15559990000",
      onEvent: (event) => events.push(event),
      pollTimeoutSec: 1,
    });

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(firstRequest.params).toEqual(
      expect.objectContaining({
        account: "+15559990000",
        timeout: 1,
      }),
    );
    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(secondRequest.params).toEqual({ timeout: 1 });
  });

  it("remembers when receive must omit account for a base URL", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message:
                'Unrecognized field "account" (class org.asamk.signal.commands.ReceiveCommand$ReceiveParams)',
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: [],
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: [],
          }),
        }),
      );

    await pollSignalJsonRpc({
      baseUrl: "http://signal.local",
      account: "+15559990000",
      onEvent: () => {},
      pollTimeoutSec: 1,
    });
    await pollSignalJsonRpc({
      baseUrl: "http://signal.local",
      account: "+15559990000",
      onEvent: () => {},
      pollTimeoutSec: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const cachedRequest = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(cachedRequest.params).toEqual({ timeout: 1 });
  });

  it("returns immediately from JSON-RPC polling when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await pollSignalJsonRpc({
      baseUrl: "http://signal.local",
      abortSignal: controller.signal,
      onEvent: () => {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
