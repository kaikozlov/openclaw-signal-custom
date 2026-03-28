import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { resolveSignalAccount } from "./config.js";
import { setSignalRuntime } from "./runtime.js";
import { __clearSignalDirectoryCacheForTests } from "./signal/directory.js";
import {
  __clearSignalReactionTargetCacheForTests,
  recordSignalReactionTarget,
} from "./signal/reaction-target-cache.js";

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
  } as Response;
}

function makeSignalCfg(channelOverrides: Record<string, unknown> = {}) {
  return {
    channels: {
      "signal-custom": {
        account: "+15550001111",
        httpUrl: "http://signal.local",
        ...channelOverrides,
      },
    },
  } as never;
}

describe("signalPlugin outbound sendMedia", () => {
  beforeEach(() => {
    __clearSignalDirectoryCacheForTests();
    __clearSignalReactionTargetCacheForTests();
  });

  afterEach(() => {
    __clearSignalDirectoryCacheForTests();
    __clearSignalReactionTargetCacheForTests();
  });

  it("declares blockStreaming and mention strip patterns", () => {
    expect(signalPlugin.capabilities?.blockStreaming).toBe(true);
    expect(signalPlugin.capabilities?.edit).toBe(true);
    expect(signalPlugin.capabilities?.polls).toBe(true);
    expect(signalPlugin.capabilities?.unsend).toBe(true);
    expect(signalPlugin.mentions?.stripPatterns?.({} as never)).toEqual(["\uFFFC"]);
  });

  it("advertises Signal-specific message tool hints", () => {
    expect(
      signalPlugin.agentPrompt?.messageToolHints?.({
        cfg: makeSignalCfg(),
        accountId: "default",
      } as never),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("view-once"),
        expect.stringContaining("story replies"),
        expect.stringContaining("mentions"),
      ]),
    );
  });

  it("formats signal daemon version in capabilities probe output", () => {
    expect(
      signalPlugin.status?.formatCapabilitiesProbe?.({
        probe: { version: "0.13.17" },
      } as never),
    ).toEqual([{ text: "Signal daemon: 0.13.17" }]);
    expect(
      signalPlugin.status?.formatCapabilitiesProbe?.({
        probe: { ok: true },
      } as never),
    ).toEqual([]);
  });

  it("resolves allowlist entries to signal contact names", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          {
            name: "Alice",
            number: "+15551234567",
            uuid: "123E4567-E89B-12D3-A456-426614174000",
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    try {
      const resolved = await signalPlugin.allowlist?.resolveNames?.({
        cfg: makeSignalCfg(),
        accountId: "default",
        scope: "dm",
        entries: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000", "+15550009999"],
      });

      expect(resolved).toEqual([
        { input: "+15551234567", resolved: true, name: "Alice" },
        {
          input: "uuid:123e4567-e89b-12d3-a456-426614174000",
          resolved: true,
          name: "Alice",
        },
        { input: "+15550009999", resolved: false },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("extracts direct send targets from message-tool sendMessage actions", () => {
    expect(
      signalPlugin.actions?.extractToolSend?.({
        args: {
          action: "sendMessage",
          to: "signal-custom:group:grp1",
          accountId: "work",
        },
      }),
    ).toEqual({
      to: "group:grp1",
      accountId: "work",
    });
  });

  it("exposes merged per-group allowlist overrides through the allowlist adapter", async () => {
    const readConfig = await signalPlugin.allowlist?.readConfig?.({
      cfg: makeSignalCfg({
        groups: {
          "*": { allowFrom: ["+15550001111"] },
          grp1: { allowFrom: ["+15550002222"] },
        },
        accounts: {
          Work: {
            groups: {
              grp1: { allowFrom: ["uuid:123e4567-e89b-12d3-a456-426614174000"] },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(readConfig).toEqual(
      expect.objectContaining({
        groupOverrides: [
          { label: "Signal groups (*)", entries: ["+15550001111"] },
          {
            label: "Signal group grp1",
            entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
          },
        ],
      }),
    );
  });

  it("inspects signal account state through the plugin config adapter", () => {
    const inspected = signalPlugin.config.inspectAccount?.(
      {
        channels: {
          "signal-custom": {
            account: "+15550001111",
            configPath: "/tmp/signal-cli",
            accounts: {
              Work: {
                account: "+15550002222",
                tcpHost: "127.0.0.1",
                tcpPort: 7583,
              },
            },
          },
        },
      } as never,
      "work",
    );

    expect(inspected).toEqual(
      expect.objectContaining({
        accountId: "work",
        enabled: true,
        configured: true,
        accountNumber: "+15550002222",
        baseUrl: "http://127.0.0.1:8080",
        connectionMode: "tcp",
        transportSummary: "managed HTTP + TCP transport",
        effectiveAutoStart: true,
        configPathSet: true,
        attachmentFastPathLikely: true,
        receiveMode: "on-start",
      }),
    );
  });

  it("includes transport diagnostics in the account status snapshot", async () => {
    const account = resolveSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            accounts: {
              Work: {
                account: "+15550002222",
                httpUrl: "http://signal.example:8080",
              },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    const snapshot = await signalPlugin.status?.buildAccountSnapshot?.({
      account,
      runtime: null,
      probe: { ok: false, error: "timeout" },
    } as never);

    expect(snapshot).toEqual(
      expect.objectContaining({
        accountId: "work",
        baseUrl: "http://signal.example:8080",
        connectionMode: "external-http",
        transportSummary: "external HTTP daemon",
        effectiveAutoStart: false,
        configPathSet: false,
        attachmentFastPathLikely: false,
        receiveMode: "on-start",
        reactionDelivery: "queue",
        reactionDeliveryStatus: "reaction delivery: queued",
      }),
    );
    expect(
      signalPlugin.status?.formatCapabilitiesProbe?.({
        probe: { ok: false, error: "timeout" },
      } as never),
    ).toEqual([{ text: "Signal probe error: timeout" }]);
  });

  it("compiles and matches configured Signal ACP conversation bindings", () => {
    const compiled = signalPlugin.bindings?.compileConfiguredBinding({
      binding: {} as never,
      conversationId: "signal-custom:group:test-group",
    });

    expect(compiled).toEqual({ conversationId: "group:test-group" });
    expect(
      signalPlugin.bindings?.matchInboundConversation({
        binding: {} as never,
        compiledBinding: compiled ?? { conversationId: "" },
        conversationId: "group:test-group",
      }),
    ).toEqual({ conversationId: "group:test-group", matchPriority: 2 });
    expect(
      signalPlugin.bindings?.matchInboundConversation({
        binding: {} as never,
        compiledBinding: compiled ?? { conversationId: "" },
        conversationId: "+15550001111",
      }),
    ).toBeNull();
  });

  it("exposes Signal exec-approval integration when approvers are configured", () => {
    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15551234567",
          execApprovals: {
            enabled: true,
            approvers: ["+15550001111"],
            target: "dm",
          },
        },
      },
    } as never;

    expect(
      signalPlugin.execApprovals?.getInitiatingSurfaceState?.({
        cfg,
        accountId: "default",
      }),
    ).toEqual({ kind: "enabled" });
    expect(signalPlugin.execApprovals?.hasConfiguredDmRoute?.({ cfg })).toBe(true);
    expect(
      signalPlugin.execApprovals?.shouldSuppressForwardingFallback?.({
        cfg,
        target: { channel: "signal-custom", to: "+15550001111", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            turnSourceChannel: "signal-custom",
            turnSourceAccountId: "default",
          },
        },
      } as never),
    ).toBe(true);
  });

  it("does not advertise a DM exec-approval route for channel-only configs", () => {
    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15551234567",
          execApprovals: {
            enabled: true,
            approvers: ["+15550001111"],
            target: "channel",
          },
        },
      },
    } as never;

    expect(signalPlugin.execApprovals?.hasConfiguredDmRoute?.({ cfg })).toBe(false);
    expect(
      signalPlugin.execApprovals?.shouldSuppressForwardingFallback?.({
        cfg,
        target: { channel: "signal-custom", to: "+15550001111", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            turnSourceChannel: "signal-custom",
            turnSourceAccountId: "default",
          },
        },
      } as never),
    ).toBe(false);
    expect(
      signalPlugin.execApprovals?.shouldSuppressForwardingFallback?.({
        cfg,
        target: { channel: "signal-custom", to: "group:grp1", accountId: "default" },
        request: {
          id: "approval-2",
          request: {
            turnSourceChannel: "signal-custom",
            turnSourceAccountId: "default",
          },
        },
      } as never),
    ).toBe(true);
  });

  it("normalizes Signal threading reply transport to replyToId", () => {
    expect(
      signalPlugin.threading?.resolveReplyTransport?.({
        cfg: {} as never,
        accountId: "default",
        threadId: "1712345678901",
      }),
    ).toEqual({
      replyToId: "1712345678901",
      threadId: null,
    });
    expect(
      signalPlugin.threading?.resolveReplyToMode?.({
        cfg: {
          channels: {
            "signal-custom": {
              replyToMode: "first",
            },
          },
        } as never,
        accountId: "default",
      }),
    ).toBe("first");
  });

  it("resolves user targets from signal contacts", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          {
            name: "Alice Example",
            number: "+15551234567",
            uuid: "123e4567-e89b-12d3-a456-426614174000",
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    try {
      const resolved = await signalPlugin.resolver?.resolveTargets({
        cfg: makeSignalCfg(),
        accountId: "default",
        inputs: ["Alice Example", "uuid:123e4567-e89b-12d3-a456-426614174000", "+15550009999"],
        kind: "user",
        runtime: {} as never,
      });

      expect(resolved).toEqual([
        {
          input: "Alice Example",
          resolved: true,
          id: "+15551234567",
          name: "Alice Example",
        },
        {
          input: "uuid:123e4567-e89b-12d3-a456-426614174000",
          resolved: true,
          id: "+15551234567",
          name: "Alice Example",
        },
        {
          input: "+15550009999",
          resolved: false,
          note: "no matching Signal contact",
        },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("resolves group targets from signal groups", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          {
            id: "group-123",
            name: "Work Group",
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    try {
      const resolved = await signalPlugin.resolver?.resolveTargets({
        cfg: makeSignalCfg(),
        accountId: "default",
        inputs: ["Work Group", "group:group-123", "missing group"],
        kind: "group",
        runtime: {} as never,
      });

      expect(resolved).toEqual([
        {
          input: "Work Group",
          resolved: true,
          id: "group:group-123",
          name: "Work Group",
        },
        {
          input: "group:group-123",
          resolved: true,
          id: "group:group-123",
          name: "Work Group",
        },
        {
          input: "missing group",
          resolved: false,
          note: "no matching Signal group",
        },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to matching contacts when group resolution receives Signal user inputs", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: [],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          jsonrpc: "2.0",
          result: [
            {
              name: "Casey",
              number: "+15550003333",
              uuid: "123e4567-e89b-12d3-a456-426614174000",
            },
          ],
        }),
      );
    global.fetch = fetchMock;
    try {
      const resolved = await signalPlugin.resolver?.resolveTargets({
        cfg: makeSignalCfg(),
        accountId: "default",
        inputs: ["Casey", "+15550003333"],
        kind: "group",
        runtime: {} as never,
      });

      expect(resolved).toEqual([
        {
          input: "Casey",
          resolved: true,
          id: "+15550003333",
          name: "Casey",
          note: "matched Signal contact",
        },
        {
          input: "+15550003333",
          resolved: true,
          id: "+15550003333",
          name: "Casey",
          note: "matched Signal contact",
        },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
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
    const cfg = {
      channels: {
        "signal-custom": {
          groups: {
            "*": {
              requireMention: true,
              tools: { deny: ["exec"] },
            },
            grp1: {
              requireMention: false,
              tools: { allow: ["message"] },
            },
          },
          accounts: {
            Work: {
              groups: {
                grp1: {
                  toolsBySender: {
                    "id:user-123": { deny: ["exec"] },
                  },
                },
              },
            },
          },
        },
      },
    } as never;

    const requireMention = signalPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "signal:group:grp1",
      accountId: "work",
    });
    const toolPolicy = signalPlugin.groups?.resolveToolPolicy?.({
      cfg,
      groupId: "signal:group:grp1",
      accountId: "work",
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
          targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
          targetTimestamp: 1700000000456,
        }),
      );
      expect(body.params.recipients).toBeUndefined();
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

  it("returns null discovery when no configured accounts are available", () => {
    expect(signalPlugin.actions?.describeMessageTool?.({ cfg: {} as never })).toBeNull();
  });

  it("keeps discovery limited to send when optional actions are disabled", () => {
    const discovery = signalPlugin.actions?.describeMessageTool?.({
      cfg: makeSignalCfg({
        actions: {
          reactions: false,
          unsend: false,
          editMessage: false,
          deleteMessage: false,
          pinMessage: false,
          stickers: false,
          groupManagement: false,
        },
      }),
    });

    expect(discovery?.actions).toEqual(["send"]);
    expect(discovery?.schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visibility: "all-configured",
          properties: expect.objectContaining({
            mentions: expect.anything(),
            viewOnce: expect.anything(),
            quoteAuthor: expect.anything(),
            storyTimestamp: expect.anything(),
            storyAuthor: expect.anything(),
          }),
        }),
      ]),
    );
    expect(discovery?.capabilities).toEqual([]);
  });

  it("lists edit/delete actions from plugin-local gate when enabled", () => {
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            describeMessageTool: () => ({ actions: ["send"] }),
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
    const actions = signalPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [];
    expect(actions).toContain("send");
    expect(actions).toContain("edit");
    expect(actions).toContain("delete");
    expect(actions).toContain("unsend");
  });

  it("lists pin/unpin actions when actions.pinMessage is enabled", () => {
    const actions = signalPlugin.actions?.describeMessageTool?.({
      cfg: makeSignalCfg({
        actions: {
          pinMessage: true,
        },
      }),
    })?.actions ?? [];

    expect(actions).toContain("pin");
    expect(actions).toContain("unpin");
  });

  it("handles local send actions with Signal-specific media options", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      makeResponse({ jsonrpc: "2.0", result: { timestamp: 1700000000005 } }),
    );
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "send",
        cfg: makeSignalCfg(),
        params: {
          to: "signal:group:group-1",
          message: "hello",
          replyTo: "1700000000000",
          silent: true,
          quoteAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
          storyTimestamp: 1700000000001,
          storyAuthor: "+15550002222",
          mentions: [
            {
              start: 0,
              length: 5,
              recipient: "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
            },
          ],
        },
      } as never);

      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            sent: true,
            messageId: "1700000000005",
            messageIds: ["1700000000005"],
          }),
        }),
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("send");
      expect(body.params).toEqual(
        expect.objectContaining({
          groupId: "group-1",
          account: "+15550001111",
          message: "hello",
          noUrgent: true,
          quoteTimestamp: 1700000000000,
          quoteAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
          "story-timestamp": 1700000000001,
          "story-author": "+15550002222",
          mention: ["0:5:123e4567-e89b-12d3-a456-426614174000"],
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks pin when actions.pinMessage is disabled", async () => {
    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "pin",
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              actions: {
                pinMessage: false,
              },
            },
          },
        } as never,
        params: {
          to: "signal:+15550001111",
          messageId: "1700000000000",
          targetAuthor: "+15550001111",
        },
      } as never),
    ).rejects.toThrow(/actions\.pinMessage/);
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
            describeMessageTool: () => ({ actions: ["send"] }),
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
    const actions = signalPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [];
    expect(actions).toContain("sticker");
    expect(actions).toContain("sticker-search");
  });

  it("lists group-management actions when actions.groupManagement is enabled", () => {
    setSignalRuntime({
      channel: {
        signal: {
          messageActions: {
            describeMessageTool: () => ({ actions: ["send"] }),
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
    const actions = signalPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [];
    expect(actions).toContain("renameGroup");
    expect(actions).toContain("setGroupIcon");
    expect(actions).toContain("addParticipant");
    expect(actions).toContain("removeParticipant");
    expect(actions).toContain("role-add");
    expect(actions).toContain("role-remove");
    expect(actions).toContain("ban");
    expect(actions).toContain("channel-edit");
    expect(actions).toContain("permissions");
    expect(actions).toContain("leaveGroup");
    expect(actions).toContain("member-info");
    expect(actions).toContain("channel-info");
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

  it.each(["delete", "unsend"] as const)(
    "handles %s action locally without runtime messageActions.handleAction",
    async (action) => {
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
      fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));
      global.fetch = fetchMock;
      try {
        const result = await signalPlugin.actions?.handleAction?.({
          channel: "signal-custom",
          action,
          cfg: makeSignalCfg(),
          params: {
            to: "signal:group:group-1",
            messageId: "1700000000000",
          },
        } as never);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(handleAction).not.toHaveBeenCalled();
        const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
          method: string;
          params: Record<string, unknown>;
        };
        expect(body.method).toBe("remoteDelete");
        expect(body.params).toEqual(
          expect.objectContaining({
            groupId: "group-1",
            targetTimestamp: 1700000000000,
          }),
        );
        expect(result).toEqual(
          expect.objectContaining({
            details: expect.objectContaining({
              ok: true,
              deleted: true,
              messageId: "1700000000000",
            }),
          }),
        );
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

  it.each([
    ["pin", "sendPinMessage"],
    ["unpin", "sendUnpinMessage"],
  ] as const)(
    "handles %s action locally without runtime messageActions.handleAction",
    async (action, method) => {
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
      fetchMock.mockResolvedValueOnce(
        makeResponse({ jsonrpc: "2.0", result: { timestamp: 1700000000005 } }),
      );
      global.fetch = fetchMock;
      try {
        const result = await signalPlugin.actions?.handleAction?.({
          channel: "signal-custom",
          action,
          cfg: makeSignalCfg(),
          params: {
            to: "signal:group:group-1",
            messageId: "1700000000000",
            targetAuthor: "+15550002222",
            pinDuration: -1,
          },
        } as never);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(handleAction).not.toHaveBeenCalled();
        const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
          method: string;
          params: Record<string, unknown>;
        };
        expect(body.method).toBe(method);
        expect(body.params).toEqual(
          expect.objectContaining({
            groupId: "group-1",
            targetAuthor: "+15550002222",
            targetTimestamp: 1700000000000,
          }),
        );
        if (action === "pin") {
          expect(body.params.pinDuration).toBe(-1);
        }
        expect(result).toEqual(
          expect.objectContaining({
            details: expect.objectContaining({
              ok: true,
              ...(action === "pin" ? { pinned: true } : { unpinned: true }),
              messageId: "1700000000000",
            }),
          }),
        );
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

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

  it("handles sticker-search locally without runtime messageActions.handleAction", async () => {
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
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: {
          stickerPacks: [
            { packId: "pack-alpha", title: "Alpha Pack", author: "Casey" },
            { packId: "pack-beta", title: "Beta Pack", author: "Casey" },
          ],
        },
      }),
    );
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "sticker-search",
        cfg: makeSignalCfg({
          actions: {
            stickers: true,
          },
        }),
        params: {
          query: "alpha",
          limit: 1,
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          details: {
            ok: true,
            packs: [{ packId: "pack-alpha", title: "Alpha Pack", author: "Casey" }],
          },
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

  it.each([
    {
      action: "channel-edit",
      params: {
        channelId: "signal:group:group-1",
        description: "  Ops Room  ",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        description: "Ops Room",
      },
      expectedDetails: { ok: true, groupId: "group-1", description: "Ops Room" },
    },
    {
      action: "addParticipant",
      params: {
        chatId: "signal:group:group-1",
        participant: "signal:uuid:member-1",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        member: ["member-1"],
      },
      expectedDetails: { ok: true, added: "signal:uuid:member-1", groupId: "group-1" },
    },
    {
      action: "removeParticipant",
      params: {
        chatGuid: "signal:group:group-1",
        member: "+15550002222",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        removeMember: ["+15550002222"],
      },
      expectedDetails: { ok: true, removed: "+15550002222", groupId: "group-1" },
    },
    {
      action: "role-add",
      params: {
        channelId: "signal:group:group-1",
        userId: "signal:+15550003333",
        roleId: "admin",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        admin: ["+15550003333"],
      },
      expectedDetails: { ok: true, promoted: "signal:+15550003333", groupId: "group-1", role: "admin" },
    },
    {
      action: "role-remove",
      params: {
        channelId: "signal:group:group-1",
        userId: "signal:uuid:admin-2",
        roleId: "admin",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        removeAdmin: ["admin-2"],
      },
      expectedDetails: { ok: true, demoted: "signal:uuid:admin-2", groupId: "group-1", role: "admin" },
    },
    {
      action: "ban",
      params: {
        channelId: "signal:group:group-1",
        userId: "+15550004444",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        ban: ["+15550004444"],
      },
      expectedDetails: { ok: true, banned: "+15550004444", groupId: "group-1" },
    },
    {
      action: "ban",
      params: {
        channelId: "signal:group:group-1",
        userId: "signal:uuid:banned-1",
        unban: true,
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        unban: ["banned-1"],
      },
      expectedDetails: { ok: true, unbanned: "signal:uuid:banned-1", groupId: "group-1" },
    },
    {
      action: "channel-edit",
      params: {
        channelId: "signal:group:group-1",
        state: "enabled-with-approval",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        link: "enabledWithApproval",
      },
      expectedDetails: { ok: true, groupId: "group-1", link: "enabledWithApproval" },
    },
    {
      action: "channel-edit",
      params: {
        channelId: "signal:group:group-1",
        resetLink: true,
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        resetLink: true,
      },
      expectedDetails: { ok: true, groupId: "group-1", resetLink: true },
    },
    {
      action: "permissions",
      params: {
        channelId: "signal:group:group-1",
        setting: "add-member",
        permission: "only-admins",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        setPermissionAddMember: "onlyAdmins",
      },
      expectedDetails: { ok: true, groupId: "group-1", setting: "add-member", permission: "onlyAdmins" },
    },
    {
      action: "permissions",
      params: {
        channelId: "signal:group:group-1",
        setting: "edit-details",
        permission: "every-member",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        setPermissionEditDetails: "everyMember",
      },
      expectedDetails: { ok: true, groupId: "group-1", setting: "edit-details", permission: "everyMember" },
    },
    {
      action: "permissions",
      params: {
        channelId: "signal:group:group-1",
        setting: "send-messages",
        permission: "only-admins",
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        setPermissionSendMessages: "onlyAdmins",
      },
      expectedDetails: { ok: true, groupId: "group-1", setting: "send-messages", permission: "onlyAdmins" },
    },
    {
      action: "permissions",
      params: {
        channelId: "signal:group:group-1",
        enabled: true,
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        setPermissionSendMessages: "onlyAdmins",
      },
      expectedDetails: {
        ok: true,
        groupId: "group-1",
        setting: "announcements",
        announcements: true,
        permission: "onlyAdmins",
      },
    },
    {
      action: "channel-edit",
      params: {
        channelId: "signal:group:group-1",
        seconds: 3600,
      },
      expectedMethod: "updateGroup",
      expectedParams: {
        groupId: "group-1",
        expiration: 3600,
      },
      expectedDetails: { ok: true, groupId: "group-1", expiration: 3600 },
    },
    {
      action: "leaveGroup",
      params: {
        to: "signal:group:group-1",
      },
      expectedMethod: "quitGroup",
      expectedParams: {
        groupId: "group-1",
      },
      expectedDetails: { ok: true, left: "group-1" },
    },
  ] as const)(
    "handles $action locally without runtime messageActions.handleAction",
    async ({ action, params, expectedMethod, expectedParams, expectedDetails }) => {
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
      fetchMock.mockResolvedValueOnce(makeResponse({ jsonrpc: "2.0", result: null }));
      global.fetch = fetchMock;
      try {
        const result = await signalPlugin.actions?.handleAction?.({
          channel: "signal-custom",
          action,
          cfg: makeSignalCfg(),
          params,
        } as never);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(handleAction).not.toHaveBeenCalled();
        const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
          method: string;
          params: Record<string, unknown>;
        };
        expect(body.method).toBe(expectedMethod);
        expect(body.params).toEqual(expect.objectContaining(expectedParams));
        expect(result).toEqual(
          expect.objectContaining({
            details: expect.objectContaining(expectedDetails),
          }),
        );
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

  it("handles setGroupIcon using hydrated runner buffer payload", async () => {
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
    let avatarPathSeen = "";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      avatarPathSeen = String(body.params.avatar ?? "");
      expect(body.method).toBe("updateGroup");
      expect(body.params).toEqual(
        expect.objectContaining({
          groupId: "group-1",
          avatar: expect.any(String),
        }),
      );
      expect(existsSync(avatarPathSeen)).toBe(true);
      return makeResponse({ jsonrpc: "2.0", result: null });
    });
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "setGroupIcon",
        cfg: makeSignalCfg(),
        params: {
          channelId: "signal:group:group-1",
          buffer: Buffer.from("fake-image").toString("base64"),
          filename: "group.png",
          contentType: "image/png",
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      expect(avatarPathSeen.endsWith("group.png")).toBe(true);
      expect(existsSync(avatarPathSeen)).toBe(false);
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            groupId: "group-1",
            avatar: avatarPathSeen,
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles member-info locally without runtime messageActions.handleAction", async () => {
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
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "member-info",
        cfg: makeSignalCfg(),
        params: {
          channelId: "signal:group:group-1",
          userId: "+15550002222",
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("listGroups");
      expect(body.params).toEqual(expect.objectContaining({ detailed: true }));
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            groupId: "group-1",
            memberId: "+15550002222",
            member: { number: "+15550002222", name: "Alice" },
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles channel-info locally without runtime messageActions.handleAction", async () => {
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
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: [
          { id: "group-2", name: "Ignore Me" },
          {
            id: "group-1",
            name: "Ops",
            description: "Operators",
            groupInviteLink: "https://signal.group/#ops",
            permissionSendMessage: "ONLY_ADMINS",
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    try {
      const result = await signalPlugin.actions?.handleAction?.({
        channel: "signal-custom",
        action: "channel-info",
        cfg: makeSignalCfg(),
        params: {
          channelId: "signal:group:group-1",
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(handleAction).not.toHaveBeenCalled();
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(body.method).toBe("listGroups");
      expect(body.params).toEqual(expect.objectContaining({ detailed: true }));
      expect(result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            ok: true,
            groupId: "group-1",
            group: expect.objectContaining({
              id: "group-1",
              description: "Operators",
              groupInviteLink: "https://signal.group/#ops",
            }),
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

  it("refreshes peer directory results on subsequent lookups", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            result: [{ number: "+15550002222", name: "Alice" }],
          }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            result: [{ number: "+15550002222", name: "Jordan" }],
          }),
      } as Response);
    global.fetch = fetchMock;
    try {
      const params = {
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              directoryRefreshTtlMs: 0,
            },
          },
        } as never,
      } as never;

      await expect(signalPlugin.directory?.listPeers?.(params)).resolves.toEqual([
        expect.objectContaining({
          id: "+15550002222",
          name: "Alice",
        }),
      ]);
      await expect(signalPlugin.directory?.listPeers?.(params)).resolves.toEqual([
        expect.objectContaining({
          id: "+15550002222",
          name: "Jordan",
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
