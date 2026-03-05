import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { setSignalRuntime } from "./runtime.js";

describe("signalPlugin outbound sendMedia", () => {
  it("declares blockStreaming and mention strip patterns", () => {
    expect(signalPlugin.capabilities?.blockStreaming).toBe(true);
    expect(signalPlugin.capabilities?.edit).toBe(true);
    expect(signalPlugin.mentions?.stripPatterns?.({} as never)).toEqual(["\uFFFC"]);
  });

  it("forwards mediaLocalRoots to sendMessageSignal", async () => {
    const sendSignal = vi.fn(async () => ({ messageId: "m1" }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const sendMedia = signalPlugin.outbound?.sendMedia;
    if (!sendMedia) {
      throw new Error("signal outbound sendMedia is unavailable");
    }

    await sendMedia({
      cfg: {} as never,
      to: "signal:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "signal:+15551234567",
      "photo",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
      }),
    );
  });

  it("resolves requireMention + tool policy from signal group config", () => {
    setSignalRuntime({
      channel: {
        groups: {
          resolveRequireMention: (params: { cfg: any; groupId?: string | null }) =>
            params.cfg.channels?.signal?.groups?.[params.groupId ?? ""]?.requireMention ?? true,
          resolveGroupPolicy: (params: { cfg: any; groupId?: string | null }) => ({
            allowlistEnabled: false,
            allowed: true,
            groupConfig: params.cfg.channels?.signal?.groups?.[params.groupId ?? ""],
          }),
        },
      },
    } as never);

    const cfg = {
      channels: {
        signal: {
          groups: {
            "signal:group:grp-1": {
              requireMention: false,
              tools: { allow: ["message"] },
              toolsBySender: {
                "id:user-123": { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as never;

    const requireMention = signalPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "signal:group:grp-1",
      accountId: "default",
    });
    const toolPolicy = signalPlugin.groups?.resolveToolPolicy?.({
      cfg,
      groupId: "signal:group:grp-1",
      accountId: "default",
      senderId: "user-123",
    });

    expect(requireMention).toBe(false);
    expect(toolPolicy).toEqual({ deny: ["exec"] });
  });

  it("requires targetAuthor for react actions before runtime handler call", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: {},
      } as never),
    ).rejects.toThrow(/targetAuthor|targetAuthorUuid/);
    expect(handleAction).not.toHaveBeenCalled();

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: { targetAuthor: "+15550001111", emoji: "✅" },
      } as never),
    ).resolves.toEqual({ content: [] });
    expect(handleAction).toHaveBeenCalledTimes(1);
  });

  it("normalizes reaction targetAuthor/messageId/emoji before runtime handler", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: {
          targetAuthor: "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "00123",
          emoji: " ✅ ",
        },
      } as never),
    ).resolves.toEqual({ content: [] });

    expect(handleAction).toHaveBeenCalledTimes(1);
    const firstCall = handleAction.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("signal runtime action handler not called");
    }
    const forwarded = firstCall[0] as { params: Record<string, unknown> };
    expect(forwarded.params).toEqual(
      expect.objectContaining({
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "✅",
      }),
    );
  });

  it("rejects invalid reaction messageId before runtime handler call", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: {
          targetAuthor: "+15550001111",
          emoji: "✅",
          messageId: "not-a-number",
        },
      } as never),
    ).rejects.toThrow(/Invalid messageId/);
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("rejects reaction when emoji is missing", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: {
          targetAuthor: "+15550001111",
        },
      } as never),
    ).rejects.toThrow(/Emoji required/);
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("lists edit/delete actions from plugin-local gate when enabled", () => {
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            listActions: () => ["send"],
          },
        },
      },
    } as never);

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;
    const actions = signalPlugin.actions?.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("send");
    expect(actions).toContain("edit");
    expect(actions).toContain("delete");
  });

  it("lists sticker actions when actions.stickers is enabled", () => {
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            listActions: () => ["send"],
          },
        },
      },
    } as never);

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
          actions: {
            stickers: true,
          },
        },
      },
    } as never;
    const actions = signalPlugin.actions?.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("sticker");
    expect(actions).toContain("sticker-search");
  });

  it("lists group-management actions when actions.groupManagement is enabled", () => {
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            listActions: () => ["send"],
          },
        },
      },
    } as never);

    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;
    const actions = signalPlugin.actions?.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("renameGroup");
    expect(actions).toContain("addParticipant");
    expect(actions).toContain("removeParticipant");
    expect(actions).toContain("leaveGroup");
    expect(actions).toContain("member-info");
  });

  it("blocks group-management actions when actions.groupManagement is disabled", async () => {
    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "renameGroup",
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              actions: {
                groupManagement: false,
              },
            },
          },
        } as never,
        params: {
          groupId: "group-1",
          name: "New Name",
        },
      } as never),
    ).rejects.toThrow(/actions\.groupManagement/);
  });

  it("handles edit action locally without runtime messageActions.handleAction", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000001 },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "edit",
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          to: "signal:+15550002222",
          messageId: "1700000000000",
          message: "edited text",
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            edited: true,
            messageId: "1700000000000",
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles renameGroup locally without runtime messageActions.handleAction", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: null,
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "renameGroup",
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          groupId: "signal:group:group-1",
          name: "  New Group Name  ",
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("updateGroup");
      expect(body.params).toEqual(
        expect.objectContaining({
          groupId: "group-1",
          name: "New Group Name",
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            renamed: "group-1",
            name: "New Group Name",
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles sticker action locally without runtime messageActions.handleAction", async () => {
    const handleAction = vi.fn(async (_ctx: unknown) => ({ content: [] }));
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            handleAction,
          },
        },
      },
    } as never);

    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 1700000000002 },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "sticker",
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              actions: {
                stickers: true,
              },
            },
          },
        } as never,
        params: {
          to: "signal:+15550002222",
          packId: "pack-a",
          stickerNum: 3,
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            packId: "pack-a",
            stickerId: 3,
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("lists peers through plugin-local directory lookup", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: [
            { number: "+15550002222", name: "Alice" },
            { number: "+15550003333", name: "Bob" },
          ],
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const peers = await signalPlugin.directory?.listPeers?.({
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        query: "ali",
        limit: 1,
      } as never);

      expect(peers).toEqual([
        expect.objectContaining({
          kind: "user",
          id: "+15550002222",
          name: "Alice",
        }),
      ]);
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
      };
      expect(body.method).toBe("listContacts");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("lists group members through plugin-local detailed groups lookup", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: [
            {
              id: "group-1",
              members: [{ number: "+15550002222", name: "Alice" }],
            },
          ],
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const members = await signalPlugin.directory?.listGroupMembers?.({
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        groupId: "group:group-1",
      } as never);

      expect(members).toEqual([
        expect.objectContaining({
          kind: "user",
          id: "+15550002222",
          name: "Alice",
        }),
      ]);
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("listGroups");
      expect(body.params).toEqual(expect.objectContaining({ detailed: true }));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
