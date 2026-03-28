import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  pinMessageSignal,
  sendStickerSignal,
  unpinMessageSignal,
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
        "signal-custom": {
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

  it("preserves explicit styles and mentions for plain-text edits", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000002 },
      }),
    );

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    await editMessageSignal({
      cfg,
      to: "signal:group:group-1",
      text: "@kai hello",
      textMode: "plain",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
      mentions: [{ start: 0, length: 4, recipient: "uuid:abc-123" }],
      editTimestamp: 1700000000000,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("send");
    expect(body.params).toEqual(
      expect.objectContaining({
        message: "@kai hello",
        editTimestamp: 1700000000000,
        groupId: "group-1",
        "text-style": ["0:4:BOLD"],
        mention: ["0:4:abc-123"],
      }),
    );
  });

  it("sends deleteMessage via Signal RPC remoteDelete", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    const cfg = {
      channels: {
        "signal-custom": {
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

  it("normalizes signal-custom targets for edit and delete actions", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000100 },
        }),
      )
      .mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    await editMessageSignal({
      cfg,
      to: "signal-custom:+15550002222",
      text: "updated",
      editTimestamp: 1700000000000,
    });
    await deleteMessageSignal({
      cfg,
      to: "signal-custom:group:group-id",
      targetTimestamp: 1700000000000,
    });

    const editBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(editBody.params).toEqual(
      expect.objectContaining({
        recipient: ["+15550002222"],
      }),
    );

    const deleteBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(deleteBody.params).toEqual(
      expect.objectContaining({
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
        "signal-custom": {
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

  it("sends pinMessage via Signal RPC sendPinMessage", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000021 },
      }),
    );

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    const result = await pinMessageSignal({
      cfg,
      to: "signal:group:group-1",
      targetAuthor: "+15550002222",
      targetTimestamp: 1700000000003,
      pinDurationSeconds: -1,
    });

    expect(result).toEqual({
      messageId: "1700000000021",
      timestamp: 1700000000021,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("sendPinMessage");
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15550001111",
        groupId: "group-1",
        targetAuthor: "+15550002222",
        targetTimestamp: 1700000000003,
        pinDuration: -1,
      }),
    );
  });

  it("normalizes signal-custom targets for pin and unpin actions", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000021 },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000022 },
        }),
      );

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    await pinMessageSignal({
      cfg,
      to: "signal-custom:group:group-1",
      targetAuthor: "+15550002222",
      targetTimestamp: 1700000000003,
    });
    await unpinMessageSignal({
      cfg,
      to: "signal-custom:+15550002222",
      targetAuthor: "+15550002222",
      targetTimestamp: 1700000000004,
    });

    const pinBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(pinBody.params).toEqual(
      expect.objectContaining({
        groupId: "group-1",
      }),
    );

    const unpinBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(unpinBody.params).toEqual(
      expect.objectContaining({
        recipient: ["+15550002222"],
      }),
    );
  });

  it("sends unpinMessage via Signal RPC sendUnpinMessage", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000022 },
      }),
    );

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    const result = await unpinMessageSignal({
      cfg,
      to: "signal:+15550002222",
      targetAuthor: "+15550002222",
      targetTimestamp: 1700000000004,
    });

    expect(result).toEqual({
      messageId: "1700000000022",
      timestamp: 1700000000022,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("sendUnpinMessage");
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15550001111",
        recipient: ["+15550002222"],
        targetAuthor: "+15550002222",
        targetTimestamp: 1700000000004,
      }),
    );
  });

  it("routes stickers to groups using signal-cli groupId params", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 1700000000012 },
      }),
    );

    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;

    await sendStickerSignal({
      cfg,
      to: "signal:group:group-1",
      packId: "pack-1",
      stickerId: 8,
    });

    const call = fetchMock.mock.calls[0];
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15550001111",
        groupId: "group-1",
        sticker: "pack-1:8",
      }),
    );
    expect(body.params.recipient).toBeUndefined();
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
        "signal-custom": {
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
