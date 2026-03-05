import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  sendStickerSignal,
} from "./send-actions.js";

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
  } as Response;
}

describe("signal edit/delete actions", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends editMessage via Signal RPC send+editTimestamp", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000001 },
      }),
    );

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    const result = await editMessageSignal({
      cfg,
      to: "signal:+15550002222",
      text: "updated",
      editTimestamp: 1700000000000,
    });

    expect(result).toEqual({
      messageId: "1700000000001",
      timestamp: 1700000000001,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("http://signal.local/api/v1/rpc");
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("send");
    expect(body.params).toEqual(
      expect.objectContaining({
        message: "updated",
        editTimestamp: 1700000000000,
        recipient: ["+15550002222"],
      }),
    );
  });

  it("sends deleteMessage via Signal RPC remoteDelete", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    await deleteMessageSignal({
      cfg,
      to: "signal:group:group-id",
      targetTimestamp: 1700000000000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("http://signal.local/api/v1/rpc");
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("remoteDelete");
    expect(body.params).toEqual(
      expect.objectContaining({
        targetTimestamp: 1700000000000,
        groupId: "group-id",
      }),
    );
  });

  it("sends stickers via Signal RPC send with sticker payload", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000011 },
      }),
    );

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    const result = await sendStickerSignal({
      cfg,
      to: "signal:+15550002222",
      packId: "pack-1",
      stickerId: 4,
    });

    expect(result).toEqual({
      messageId: "1700000000011",
      timestamp: 1700000000011,
    });
    const call = fetchMock.mock.calls[0];
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("send");
    expect(body.params).toEqual(
      expect.objectContaining({
        recipient: ["+15550002222"],
        sticker: "pack-1:4",
      }),
    );
  });

  it("lists sticker packs from Signal RPC listStickerPacks", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: {
          stickerPacks: [{ packId: "pack-a", title: "Alpha Pack" }],
        },
      }),
    );

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    const packs = await listStickerPacksSignal({ cfg });
    expect(packs).toEqual([{ packId: "pack-a", title: "Alpha Pack" }]);

    const call = fetchMock.mock.calls[0];
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
    };
    expect(body.method).toBe("listStickerPacks");
  });
});
