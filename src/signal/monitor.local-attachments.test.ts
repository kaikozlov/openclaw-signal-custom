import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";
import { fetchAttachment } from "./monitor.js";

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

describe("signal monitor attachment fast path", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses the local signal-cli attachment store when the file exists", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "signal-cli-config-"));
    const attachmentsDir = path.join(configDir, "attachments");
    const attachmentPath = path.join(attachmentsDir, "abc123.png");
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-signal-custom-media/abc123.png",
      contentType: "image/png",
    }));
    setSignalRuntime({
      channel: {
        media: {
          saveMediaBuffer,
        },
      },
    } as never);
    await mkdir(attachmentsDir, { recursive: true });
    await writeFile(attachmentPath, Buffer.from("image-bytes"));

    try {
      const result = await fetchAttachment({
        baseUrl: "http://signal.local",
        configPath: configDir,
        attachment: {
          id: "abc123.png",
          contentType: "image/png",
        },
        sender: "+15550001111",
        maxBytes: 1024 * 1024,
      });

      expect(result).toEqual({
        path: "/tmp/openclaw-signal-custom-media/abc123.png",
        contentType: "image/png",
      });
      expect(saveMediaBuffer).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("falls back to getAttachment when the local signal-cli store does not contain the file", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "signal-cli-config-miss-"));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-signal-custom-media/inbound.png",
      contentType: "image/png",
    }));
    setSignalRuntime({
      channel: {
        media: {
          saveMediaBuffer,
        },
      },
    } as never);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        text: JSON.stringify({
          jsonrpc: "2.0",
          result: { data: Buffer.from("png-bytes").toString("base64") },
        }),
      }),
    );

    try {
      const result = await fetchAttachment({
        baseUrl: "http://signal.local",
        configPath: configDir,
        attachment: {
          id: "missing.png",
          contentType: "image/png",
        },
        sender: "+15550001111",
        maxBytes: 1024 * 1024,
      });

      expect(result).toEqual({
        path: "/tmp/openclaw-signal-custom-media/inbound.png",
        contentType: "image/png",
      });
      expect(saveMediaBuffer).toHaveBeenCalledOnce();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("getAttachment");
      expect(body.params).toEqual(
        expect.objectContaining({
          id: "missing.png",
          recipient: "+15550001111",
        }),
      );
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
