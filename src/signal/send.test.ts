import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";
import { resetSignalSocketRegistryForTests } from "./client.js";
import { sendMessageSignal } from "./send.js";

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
          signal: {
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
            signal: {
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
});
