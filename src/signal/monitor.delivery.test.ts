import { describe, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";
import { __deliverRepliesSignalForTests } from "./monitor.js";

function makeResponse(params: { text: string; status?: number }): Response {
  return {
    status: params.status ?? 200,
    ok: (params.status ?? 200) >= 200 && (params.status ?? 200) < 300,
    statusText: params.status === 200 || params.status === undefined ? "OK" : "ERR",
    text: async () => params.text,
  } as Response;
}

describe("signal monitor delivery", () => {
  it("only marks the last final text chunk urgent", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ text: JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1701 } }) }),
      )
      .mockResolvedValueOnce(
        makeResponse({ text: JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1702 } }) }),
      )
      .mockResolvedValueOnce(
        makeResponse({ text: JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1703 } }) }),
      );

    try {
      setSignalRuntime({
        channel: {
          text: {
            chunkTextWithMode: () => ["one", "two", "three"],
          },
        },
      } as never);

      await __deliverRepliesSignalForTests({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        replies: [{ text: "one two three" }],
        target: "+15550001111",
        baseUrl: "http://signal.local",
        account: "+15559990000",
        accountId: "default",
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        maxBytes: 8 * 1024 * 1024,
        textLimit: 3,
        chunkMode: "length",
      });

      const paramsList = fetchMock.mock.calls.map((call) => {
        const body = JSON.parse(String((call[1] as RequestInit).body)) as {
          params: Record<string, unknown>;
        };
        return body.params;
      });

      expect(paramsList).toHaveLength(3);
      expect(paramsList[0]).toEqual(expect.objectContaining({ message: "one", noUrgent: true }));
      expect(paramsList[1]).toEqual(expect.objectContaining({ message: "two", noUrgent: true }));
      expect(paramsList[2]).toEqual(
        expect.objectContaining({
          message: "three",
          recipient: ["+15550001111"],
        }),
      );
      expect(paramsList[2]?.["noUrgent"]).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("marks every non-final chunk silent", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ text: JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1701 } }) }),
      )
      .mockResolvedValueOnce(
        makeResponse({ text: JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1702 } }) }),
      );

    try {
      setSignalRuntime({
        channel: {
          text: {
            chunkTextWithMode: () => ["alpha", "beta"],
          },
        },
      } as never);

      await __deliverRepliesSignalForTests({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        replies: [{ text: "alpha beta" }],
        target: "+15550001111",
        baseUrl: "http://signal.local",
        account: "+15559990000",
        accountId: "default",
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        maxBytes: 8 * 1024 * 1024,
        textLimit: 5,
        chunkMode: "length",
        silent: true,
      });

      const paramsList = fetchMock.mock.calls.map((call) => {
        const body = JSON.parse(String((call[1] as RequestInit).body)) as {
          params: Record<string, unknown>;
        };
        return body.params;
      });

      expect(paramsList).toHaveLength(2);
      expect(paramsList[0]).toEqual(expect.objectContaining({ message: "alpha", noUrgent: true }));
      expect(paramsList[1]).toEqual(expect.objectContaining({ message: "beta", noUrgent: true }));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
