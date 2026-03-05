import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

describe("signal outbound cfg threading", () => {
  it("threads provided cfg into sendText deps call", async () => {
    const cfg = {
      channels: {
        signal: {
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
      maxBytes: 12 * 1024 * 1024,
      accountId: "work",
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-1" });
  });

  it("threads cfg + mediaUrl into sendMedia deps call", async () => {
    const cfg = {
      channels: {
        signal: {
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
      mediaUrl: "https://example.com/a.jpg",
      maxBytes: 7 * 1024 * 1024,
      accountId: "default",
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-2" });
  });

  it("forwards silent flag in sendText when requested", async () => {
    const cfg = { channels: { signal: {} } };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-3" }));

    const result = await signalPlugin.outbound!.sendText!({
      cfg,
      to: "+15550001111",
      text: "quiet ping",
      silent: true,
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15550001111", "quiet ping", {
      maxBytes: undefined,
      accountId: undefined,
      silent: true,
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-3" });
  });

  it("forwards native Signal mentions from payload channelData", async () => {
    const cfg = { channels: { signal: {} } };
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
          signal: {
            mentions: [{ start: 6, length: 4, recipient: "signal:uuid:abc-123" }],
          },
        },
      },
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("signal:+15550002222", "hello @kai", {
      maxBytes: undefined,
      accountId: undefined,
      mentions: [{ start: 6, length: 4, recipient: "abc-123" }],
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-4" });
  });

  it("applies mentions only to the first media in payload batches", async () => {
    const cfg = { channels: { signal: {} } };
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
          signal: {
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
        mediaUrl: "https://example.com/a.jpg",
        mentions: [{ start: 0, length: 2, recipient: "+15550001111" }],
      }),
    );
    expect(sendSignal).toHaveBeenNthCalledWith(
      2,
      "+15554440000",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
      }),
    );
    const secondCallOptions = sendSignal.mock.calls[1]?.[2] as { mentions?: unknown } | undefined;
    expect(secondCallOptions?.mentions).toBeUndefined();
    expect(result).toEqual({ channel: "signal", messageId: "sig-2" });
  });

  it("rejects invalid payload mention ranges", async () => {
    const cfg = { channels: { signal: {} } };
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
            signal: {
              mentions: [{ start: -1, length: 2, recipient: "signal:+15550001111" }],
            },
          },
        },
        deps: { sendSignal },
      }),
    ).rejects.toThrow(/invalid start/);
    expect(sendSignal).not.toHaveBeenCalled();
  });
});
