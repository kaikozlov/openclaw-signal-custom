import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSignalContacts, listSignalGroups, updateContactSignal } from "./directory.js";

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
  } as Response;
}

describe("signal directory RPC", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  const cfg = {
    channels: {
      "signal-custom": {
        account: "+15550001111",
        httpUrl: "http://signal.local",
      },
    },
  } as never;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("lists contacts via listContacts RPC", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [{ number: "+15550002222", name: "Alice" }],
      }),
    );

    const contacts = await listSignalContacts({ cfg });

    expect(contacts).toEqual([{ number: "+15550002222", name: "Alice" }]);
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("listContacts");
    expect(body.params).toEqual(expect.objectContaining({ account: "+15550001111" }));
  });

  it("lists groups with detailed flag when requested", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [{ id: "group-1", name: "Team" }],
      }),
    );

    const groups = await listSignalGroups({ cfg }, { detailed: true });

    expect(groups).toEqual([{ id: "group-1", name: "Team" }]);
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("listGroups");
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15550001111",
        detailed: true,
      }),
    );
  });

  it("updates a contact with normalized recipient and name", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    await updateContactSignal("signal:uuid:abc-123", "  Alice  ", { cfg });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("updateContact");
    expect(body.params).toEqual(
      expect.objectContaining({
        recipient: "abc-123",
        name: "Alice",
        account: "+15550001111",
      }),
    );
  });
});
