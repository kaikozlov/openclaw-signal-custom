import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { setSignalRuntime } from "./runtime.js";
import {
  __clearSignalReactionTargetCacheForTests,
  recordSignalReactionTarget,
} from "./signal/reaction-target-cache.js";

describe("signalPlugin outbound sendMedia", () => {
  it("declares blockStreaming and mention strip patterns", () => {
    expect(signalPlugin.capabilities?.blockStreaming).toBe(true);
    expect(signalPlugin.capabilities?.edit).toBe(true);
    expect(signalPlugin.capabilities?.polls).toBe(true);
    expect(signalPlugin.capabilities?.unsend).toBe(true);
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

  it("forwards replyToId on direct sendText adapter path", async () => {
    const sendSignal = vi.fn(async (..._args: unknown[]) => ({ messageId: "m1" }));
    const sendText = signalPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("signal outbound sendText is unavailable");
    }

    await sendText({
      cfg: {} as never,
      to: "signal:+15551234567",
      text: "replying",
      replyToId: "1700000000000",
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "signal:+15551234567",
      "replying",
      expect.objectContaining({
        accountId: "default",
        replyTo: "1700000000000",
      }),
    );
  });

  it("keeps payload replyToId only on the first outbound media send", async () => {
    const sendSignal = vi.fn(async (..._args: unknown[]) => ({ messageId: "m1" }));
    const sendPayload = signalPlugin.outbound?.sendPayload;
    if (!sendPayload) {
      throw new Error("signal outbound sendPayload is unavailable");
    }

    await sendPayload({
      cfg: {} as never,
      to: "signal:+15551234567",
      payload: {
        text: "album",
        mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        replyToId: "1700000000001",
      },
      accountId: "default",
      deps: { sendSignal },
    } as never);

    expect(sendSignal).toHaveBeenCalledTimes(2);
    expect((sendSignal.mock.calls[0]?.[2] as unknown)).toEqual(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        replyTo: "1700000000001",
      }),
    );
    expect((sendSignal.mock.calls[1]?.[2] as unknown)).toEqual(
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
      }),
    );
    expect(((sendSignal.mock.calls[1]?.[2] as unknown as Record<string, unknown>).replyTo)).toBeUndefined();
  });

  it("resolves requireMention + tool policy from signal group config", () => {
    setSignalRuntime({
      channel: {
        groups: {
          resolveRequireMention: (params: { cfg: any; groupId?: string | null }) =>
            params.cfg.channels?.["signal-custom"]?.groups?.[params.groupId ?? ""]?.requireMention ?? true,
          resolveGroupPolicy: (params: { cfg: any; groupId?: string | null }) => ({
            allowlistEnabled: false,
            allowed: true,
            groupConfig: params.cfg.channels?.["signal-custom"]?.groups?.[params.groupId ?? ""],
          }),
        },
      },
    } as never);

    const cfg = {
      channels: {
        "signal-custom": {
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

  it("requires targetAuthor for group reactions before local handler call", async () => {
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
        channel: "signal-custom",
        action: "react",
        cfg: {} as never,
        params: {
          to: "signal:group:group-1",
          messageId: "123",
          emoji: "✅",
        },
      } as never),
    ).rejects.toThrow(/targetAuthor|targetAuthorUuid/);
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("normalizes reaction targetAuthor/messageId/emoji and handles locally", async () => {
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
          result: { timestamp: 1700000000100, results: [{ type: "SUCCESS" }] },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "react",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          to: "signal:+15550001111",
          targetAuthor: "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "00123",
          emoji: " ✅ ",
        },
      } as never);

      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            added: "✅",
            timestamp: 1700000000100,
          }),
        }),
      );
      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("sendReaction");
      expect(body.params).toEqual(
        expect.objectContaining({
          recipients: ["+15550001111"],
          targetTimestamp: 123,
          targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
          emoji: "✅",
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("hydrates group reaction target authors from the local reaction cache", async () => {
    __clearSignalReactionTargetCacheForTests();
    recordSignalReactionTarget({
      groupId: "group-1",
      messageId: "1700000000456",
      senderId: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

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
          result: { timestamp: 1700000000100, results: [{ type: "SUCCESS" }] },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "react",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          to: "signal:group:group-1",
          messageId: "1700000000456",
          emoji: "✅",
        },
      } as never);

      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(body.params).toEqual(
        expect.objectContaining({
          groupIds: ["group-1"],
          recipients: ["123e4567-e89b-12d3-a456-426614174000"],
          targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
          targetTimestamp: 1700000000456,
        }),
      );
    } finally {
      __clearSignalReactionTargetCacheForTests();
      global.fetch = originalFetch;
    }
  });

  it("fills direct reaction targetAuthor from the DM recipient when no explicit author is provided", async () => {
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
          result: { timestamp: 1700000000101, results: [{ type: "SUCCESS" }] },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "react",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          to: "signal:+15550002222",
          messageId: "1700000000457",
          emoji: "✅",
        },
      } as never);

      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(body.params).toEqual(
        expect.objectContaining({
          recipients: ["+15550002222"],
          targetAuthor: "+15550002222",
          targetTimestamp: 1700000000457,
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("prefers cached direct reaction authors when a uuid is available", async () => {
    __clearSignalReactionTargetCacheForTests();
    recordSignalReactionTarget({
      recipient: "+15550002222",
      messageId: "1700000000458",
      senderId: "uuid:123e4567-e89b-12d3-a456-426614174000",
      senderE164: "+15550002222",
    });

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
          result: { timestamp: 1700000000102, results: [{ type: "SUCCESS" }] },
        }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "react",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        params: {
          to: "signal:+15550002222",
          messageId: "1700000000458",
          emoji: "✅",
        },
      } as never);

      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(body.params).toEqual(
        expect.objectContaining({
          recipients: ["+15550002222"],
          targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
          targetTimestamp: 1700000000458,
        }),
      );
    } finally {
      __clearSignalReactionTargetCacheForTests();
      global.fetch = originalFetch;
    }
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
        channel: "signal-custom",
        action: "react",
        cfg: {} as never,
        params: {
          to: "signal:+15550001111",
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
        channel: "signal-custom",
        action: "react",
        cfg: {} as never,
        params: {
          to: "signal:+15550001111",
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
        "signal-custom": {
          account: "+15550001111",
          httpUrl: "http://signal.local",
        },
      },
    } as never;
    const actions = signalPlugin.actions?.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("send");
    expect(actions).toContain("edit");
    expect(actions).toContain("delete");
    expect(actions).toContain("unsend");
  });

  it("blocks unsend when actions.unsend is disabled", async () => {
    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "unsend",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              actions: {
                unsend: false,
              },
            },
          },
        } as never,
        params: {
          to: "signal:+15550001111",
          messageId: "1700000000000",
        },
      } as never),
    ).rejects.toThrow(/actions\.unsend/);
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
        "signal-custom": {
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
        "signal-custom": {
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
        channel: "signal-custom",
        action: "renameGroup",
        cfg: {
          channels: {
            "signal-custom": {
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
        channel: "signal-custom",
        action: "edit",
        cfg: {
          channels: {
            "signal-custom": {
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
        channel: "signal-custom",
        action: "renameGroup",
        cfg: {
          channels: {
            "signal-custom": {
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
        channel: "signal-custom",
        action: "sticker",
        cfg: {
          channels: {
            "signal-custom": {
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
            "signal-custom": {
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
            "signal-custom": {
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
