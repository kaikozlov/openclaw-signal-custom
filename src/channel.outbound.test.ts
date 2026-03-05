import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { setSignalRuntime } from "./runtime.js";
import { resetSignalSocketRegistryForTests } from "./signal/client.js";

function createSocketServer() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("close", () => {
      const idx = connections.indexOf(socket);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    });

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const req = JSON.parse(line) as {
            id: string;
            method: string;
            params: Record<string, unknown>;
          };
          requests.push({ method: req.method, params: req.params });
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1700000001000 }, id: req.id })}\n`,
          );
        }
        idx = buffer.indexOf("\n");
      }
    });
  });

  return {
    requests,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve server address");
      }
      return address.port;
    },
    async close() {
      for (const connection of connections) {
        connection.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("signal outbound cfg threading", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetSignalSocketRegistryForTests();
  });

  it("threads provided cfg into sendText deps call", async () => {
    const cfg = {
      channels: {
        "signal-custom": {
          accounts: {
            work: {
              mediaMaxMb: 12,
            },
          },
          mediaMaxMb: 5,
        },
      },
    };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-1" }));

    const result = await signalPlugin.outbound!.sendText!({
      cfg,
      to: "+15551230000",
      text: "hello",
      accountId: "work",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15551230000", "hello", {
      cfg,
      maxBytes: 12 * 1024 * 1024,
      accountId: "work",
    });
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-1" });
  });

  it("threads cfg + mediaUrl into sendMedia deps call", async () => {
    const cfg = {
      channels: {
        "signal-custom": {
          mediaMaxMb: 7,
        },
      },
    };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-2" }));

    const result = await signalPlugin.outbound!.sendMedia!({
      cfg,
      to: "+15559870000",
      text: "photo",
      mediaUrl: "https://example.com/a.jpg",
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15559870000", "photo", {
      cfg,
      mediaUrl: "https://example.com/a.jpg",
      maxBytes: 7 * 1024 * 1024,
      accountId: "default",
    });
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-2" });
  });

  it("forwards silent flag in sendText when requested", async () => {
    const cfg = { channels: { "signal-custom": {} } };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-3" }));

    const result = await signalPlugin.outbound!.sendText!({
      cfg,
      to: "+15550001111",
      text: "quiet ping",
      silent: true,
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15550001111", "quiet ping", {
      cfg,
      maxBytes: undefined,
      accountId: undefined,
      silent: true,
    });
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-3" });
  });

  it("forwards native Signal mentions from payload channelData", async () => {
    const cfg = { channels: { "signal-custom": {} } };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-4" }));

    const sendPayload = signalPlugin.outbound!.sendPayload;
    if (!sendPayload) {
      throw new Error("signal outbound sendPayload is unavailable");
    }

    const result = await sendPayload({
      cfg,
      to: "signal:+15550002222",
      text: "hello @kai",
      payload: {
        text: "hello @kai",
        channelData: {
          "signal-custom": {
            mentions: [{ start: 6, length: 4, recipient: "signal:uuid:abc-123" }],
          },
        },
      },
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("signal:+15550002222", "hello @kai", {
      cfg,
      maxBytes: undefined,
      accountId: undefined,
      mentions: [{ start: 6, length: 4, recipient: "abc-123" }],
    });
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-4" });
  });

  it("applies mentions only to the first media in payload batches", async () => {
    const cfg = { channels: { "signal-custom": {} } };
    const sendSignal = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "sig-1" })
      .mockResolvedValueOnce({ messageId: "sig-2" });

    const sendPayload = signalPlugin.outbound!.sendPayload;
    if (!sendPayload) {
      throw new Error("signal outbound sendPayload is unavailable");
    }

    const result = await sendPayload({
      cfg,
      to: "+15554440000",
      text: "hi",
      payload: {
        text: "hi",
        mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        channelData: {
          "signal-custom": {
            mentions: [{ start: 0, length: 2, recipient: "signal:+15550001111" }],
          },
        },
      },
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(2);
    expect(sendSignal).toHaveBeenNthCalledWith(
      1,
      "+15554440000",
      "hi",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/a.jpg",
        mentions: [{ start: 0, length: 2, recipient: "+15550001111" }],
      }),
    );
    expect(sendSignal).toHaveBeenNthCalledWith(
      2,
      "+15554440000",
      "",
      expect.objectContaining({
        cfg,
        mediaUrl: "https://example.com/b.jpg",
      }),
    );
    const secondCallOptions = sendSignal.mock.calls[1]?.[2] as { mentions?: unknown } | undefined;
    expect(secondCallOptions?.mentions).toBeUndefined();
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-2" });
  });

  it("rejects invalid payload mention ranges", async () => {
    const cfg = { channels: { "signal-custom": {} } };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-5" }));

    const sendPayload = signalPlugin.outbound!.sendPayload;
    if (!sendPayload) {
      throw new Error("signal outbound sendPayload is unavailable");
    }

    await expect(
      sendPayload({
        cfg,
        to: "+15550003333",
        text: "bad",
        payload: {
          text: "bad",
          channelData: {
            "signal-custom": {
              mentions: [{ start: -1, length: 2, recipient: "signal:+15550001111" }],
            },
          },
        },
        deps: { sendSignal },
      }),
    ).rejects.toThrow(/invalid start/);
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("formats markdown payload text locally when mentions are absent", async () => {
    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15559990000",
          httpUrl: "http://signal.local",
        },
      },
    };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-6" }));
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);

    const sendPayload = signalPlugin.outbound!.sendPayload;
    if (!sendPayload) {
      throw new Error("signal outbound sendPayload is unavailable");
    }

    const result = await sendPayload({
      cfg,
      to: "+15550004444",
      text: "**bold** _text_",
      payload: {
        text: "**bold** _text_",
      },
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+15550004444",
      "bold text",
      expect.objectContaining({
        cfg,
        textMode: "plain",
        textStyles: [
          { start: 0, length: 4, style: "BOLD" },
          { start: 5, length: 4, style: "ITALIC" },
        ],
      }),
    );
    expect(result).toEqual({ channel: "signal-custom", messageId: "sig-6" });
  });

  it("uses the local sender over TCP for the default sendText path", async () => {
    const socketServer = createSocketServer();
    const port = await socketServer.listen();
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);

    try {
      const result = await signalPlugin.outbound!.sendText!({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
              tcpHost: "127.0.0.1",
              tcpPort: port,
            },
          },
        } as never,
        to: "+15550005555",
        text: "**hello** socket",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(socketServer.requests).toEqual([
        {
          method: "send",
          params: {
            account: "+15559990000",
            message: "hello socket",
            recipient: ["+15550005555"],
            "text-style": ["0:5:BOLD"],
          },
        },
      ]);
      expect(result).toEqual({
        channel: "signal-custom",
        messageId: "1700000001000",
        timestamp: 1700000001000,
      });
    } finally {
      await socketServer.close();
    }
  });
});
