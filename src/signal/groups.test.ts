import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearSignalDirectoryCacheForTests } from "./directory.js";
import {
  getGroupInfoSignal,
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
      "signal-custom": {
        account: "+15550001111",
        httpUrl: "http://signal.local",
      },
    },
  } as never;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    __clearSignalDirectoryCacheForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __clearSignalDirectoryCacheForTests();
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
        member: ["+15550002222", "abc-123"],
        removeMember: ["def-456"],
      }),
    );
  });

  it("normalizes signal-custom group ids and member ids", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: [
            {
              id: "group-1",
              members: [{ number: "+15550002222", name: "Alice" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    const members = await listGroupMembersSignal("signal-custom:group:group-1", { cfg });

    expect(members).toEqual([{ number: "+15550002222", name: "Alice" }]);

    await updateGroupSignal(
      "signal-custom:group:group-1",
      {
        addMembers: ["signal-custom:+15550002222", "signal-custom:uuid:abc-123"],
      },
      { cfg },
    );

    const updateBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(updateBody.params).toEqual(
      expect.objectContaining({
        groupId: "group-1",
        member: ["+15550002222", "abc-123"],
      }),
    );
  });

  it("threads extended updateGroup options using signal-cli JSON-RPC field names", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));

    await updateGroupSignal(
      "signal:group:group-9",
      {
        description: "Ops on call",
        avatar: "/tmp/group.png",
        addAdmins: ["signal:+15550003333"],
        removeAdmins: ["signal:uuid:def-456"],
        banMembers: ["+15550004444"],
        unbanMembers: ["signal:uuid:ghi-789"],
        resetLink: true,
        link: "enabled-with-approval",
        permissionAddMember: "only-admins",
        permissionEditDetails: "every-member",
        permissionSendMessages: "only-admins",
        expiration: 3600,
        memberLabelEmoji: "🛠",
        memberLabel: "Operator",
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
        groupId: "group-9",
        description: "Ops on call",
        avatar: "/tmp/group.png",
        admin: ["+15550003333"],
        removeAdmin: ["def-456"],
        ban: ["+15550004444"],
        unban: ["ghi-789"],
        resetLink: true,
        link: "enabledWithApproval",
        setPermissionAddMember: "onlyAdmins",
        setPermissionEditDetails: "everyMember",
        setPermissionSendMessages: "onlyAdmins",
        expiration: 3600,
        memberLabelEmoji: "🛠",
        memberLabel: "Operator",
      }),
    );
  });

  it("looks up a single detailed group record", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          { id: "group-1", name: "Ignore Me" },
          {
            id: "group-2",
            name: "Ops",
            description: "Operators",
            groupInviteLink: "https://signal.group/#ops",
          },
        ],
      }),
    );

    const group = await getGroupInfoSignal("group:group-2", { cfg });

    expect(group).toEqual(
      expect.objectContaining({
        id: "group-2",
        name: "Ops",
        description: "Operators",
      }),
    );
  });

  it("reuses cached detailed groups across member and info lookups", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          {
            id: "group-2",
            name: "Ops",
            members: [{ number: "+15550002222", name: "Alice" }],
          },
        ],
      }),
    );

    const members = await listGroupMembersSignal("group:group-2", { cfg });
    const group = await getGroupInfoSignal("group:group-2", { cfg });

    expect(members).toEqual([{ number: "+15550002222", name: "Alice" }]);
    expect(group).toEqual(
      expect.objectContaining({
        id: "group-2",
        name: "Ops",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
