import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  joinGroupSignal,
  listGroupMembersSignal,
  quitGroupSignal,
  updateGroupSignal,
} from "./groups.js";

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
  } as Response;
}

describe("signal groups RPC", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  const cfg = {
    channels: {
      signal: {
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

  it("lists group members by fetching detailed groups", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          {
            id: "group-1",
            members: [{ number: "+15550002222", name: "Alice" }],
          },
        ],
      }),
    );

    const members = await listGroupMembersSignal("signal:group:group-1", { cfg });

    expect(members).toEqual([{ number: "+15550002222", name: "Alice" }]);
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

  it("updates groups with normalized id and members", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    await updateGroupSignal(
      "group:group-1",
      {
        name: "  Core Team  ",
        addMembers: ["signal:+15550002222", "signal:uuid:abc-123"],
        removeMembers: [" signal:uuid:def-456 "],
      },
      { cfg },
    );

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("updateGroup");
    expect(body.params).toEqual(
      expect.objectContaining({
        account: "+15550001111",
        groupId: "group-1",
        name: "Core Team",
        addMembers: ["+15550002222", "abc-123"],
        removeMembers: ["def-456"],
      }),
    );
  });

  it("joins and quits groups via RPC", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }))
      .mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    await joinGroupSignal("https://signal.group/#C123", { cfg });
    await quitGroupSignal("signal:group:group-1", { cfg });

    const joinBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(joinBody.method).toBe("joinGroup");
    expect(joinBody.params).toEqual(
      expect.objectContaining({
        uri: "https://signal.group/#C123",
        account: "+15550001111",
      }),
    );

    const quitBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(quitBody.method).toBe("quitGroup");
    expect(quitBody.params).toEqual(
      expect.objectContaining({
        groupId: "group-1",
        account: "+15550001111",
      }),
    );
  });
});
