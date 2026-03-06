import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";
import { resetSignalSocketRegistryForTests } from "./client.js";
import {
  __clearSignalReactionTargetCacheForTests,
  recordSignalReactionTarget,
} from "./reaction-target-cache.js";
import { parseQuoteTimestamp, sendMessageSignal, sendPollCreateSignal } from "./send.js";

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

describe("sendMessageSignal", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetSignalSocketRegistryForTests();
    __clearSignalReactionTargetCacheForTests();
  });

  it("formats markdown text and forwards silent mentions over HTTP", async () => {
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000002000 },
        }),
      }),
    );

    const result = await sendMessageSignal("+15550006666", "**hi** @kai", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      silent: true,
      mentions: [{ start: 3, length: 4, recipient: "signal:uuid:abc-123" }],
    });

    expect(result).toEqual({
      messageId: "1700000002000",
      timestamp: 1700000002000,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15559990000",
        message: "hi @kai",
        noUrgent: true,
        mention: ["3:4:abc-123"],
        recipient: ["+15550006666"],
        "text-style": ["0:2:BOLD"],
      }),
    );
  });

  it("saves outbound media locally before sending attachment paths", async () => {
    const mediaDir = await mkdtemp(path.join(tmpdir(), "signal-send-"));
    const mediaPath = path.join(mediaDir, "clip.txt");
    await writeFile(mediaPath, "hello");
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-signal-custom-media/clip.txt",
    }));
    setSignalRuntime({
      channel: {
        media: {
          saveMediaBuffer,
        },
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000003000 },
        }),
      }),
    );

    try {
      const result = await sendMessageSignal("+15550007777", "", {
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        mediaUrl: pathToFileURL(mediaPath).href,
        mediaLocalRoots: [mediaDir],
      });

      expect(result).toEqual({
        messageId: "1700000003000",
        timestamp: 1700000003000,
      });
      expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(body.params).toEqual(
        expect.objectContaining({
          account: "+15559990000",
          attachments: ["/tmp/openclaw-signal-custom-media/clip.txt"],
          recipient: ["+15550007777"],
        }),
      );
      expect(body.params.message).toBe("<media:document>");
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("parses numeric quote timestamps and rejects invalid values", () => {
    expect(parseQuoteTimestamp("1771479242643")).toBe(1771479242643);
    expect(parseQuoteTimestamp("")).toBeUndefined();
    expect(parseQuoteTimestamp("not-a-number")).toBeUndefined();
    expect(parseQuoteTimestamp("-1")).toBeUndefined();
  });

  it("sends DM quote replies with quoteTimestamp even without quoteAuthor", async () => {
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000004000 },
        }),
      }),
    );

    await sendMessageSignal("+15550006666", "reply", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      replyTo: "1700000001234",
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual(
      expect.objectContaining({
        recipient: ["+15550006666"],
        quoteTimestamp: 1700000001234,
      }),
    );
    expect(body.params.quoteAuthor).toBeUndefined();
  });

  it("requires a quote author source before attaching group quote metadata", async () => {
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000005000 },
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          text: JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000005001 },
          }),
        }),
      );

    await sendMessageSignal("group:grp-1", "group reply", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      replyTo: "1700000001234",
    });
    await sendMessageSignal("group:grp-1", "group reply", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      replyTo: "1700000001234",
      quoteAuthor: "+15550001111",
    });

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(firstBody.params.quoteTimestamp).toBeUndefined();
    expect(firstBody.params.quoteAuthor).toBeUndefined();
    expect(secondBody.params).toEqual(
      expect.objectContaining({
        groupId: "grp-1",
        quoteTimestamp: 1700000001234,
        quoteAuthor: "+15550001111",
      }),
    );
  });

  it("hydrates group quoteAuthor from the inbound target cache when available", async () => {
    setSignalRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
        },
      },
    } as never);
    recordSignalReactionTarget({
      groupId: "grp-2",
      messageId: "1700000002234",
      senderId: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000006000 },
        }),
      }),
    );

    await sendMessageSignal("group:grp-2", "cached group reply", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      replyTo: "1700000002234",
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual(
      expect.objectContaining({
        groupId: "grp-2",
        quoteTimestamp: 1700000002234,
        quoteAuthor: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
  });

  it("sends Signal polls through sendPollCreate with option and noMulti params", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000007000 },
        }),
      }),
    );

    const result = await sendPollCreateSignal("group:grp-poll", {
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            httpUrl: "http://signal.local",
          },
        },
      } as never,
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      allowMultiple: true,
    });

    expect(result).toEqual({
      messageId: "1700000007000",
      timestamp: 1700000007000,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("sendPollCreate");
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15559990000",
        groupId: "grp-poll",
        question: "Lunch?",
        option: ["Pizza", "Sushi"],
        noMulti: false,
      }),
    );
  });

  it("rejects Signal polls with fewer than two options", async () => {
    await expect(
      sendPollCreateSignal("+15550001111", {
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        question: "Lunch?",
        options: ["Pizza"],
      }),
    ).rejects.toThrow(/at least two poll options/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
