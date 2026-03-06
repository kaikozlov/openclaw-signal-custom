import { describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { setSignalRuntime } from "../runtime.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

function makeResponse(text: string): Response {
  return {
    status: 200,
    ok: true,
    statusText: "OK",
    text: async () => text,
  } as Response;
}

function isReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  return Boolean(
    reaction?.emoji &&
      typeof reaction.targetSentTimestamp === "number" &&
      (reaction.targetAuthor || reaction.targetAuthorUuid),
  );
}

describe("signal monitor event handler", () => {
  it("sends stop typing when reply cleanup runs", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {},
          }),
        ),
      )
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {},
          }),
        ),
      );

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          typingCallbacks: {
            onReplyStart: () => Promise<void>;
            onCleanup?: () => void;
          };
        };
      }) => {
        await dispatcherOptions.typingCallbacks.onReplyStart();
        dispatcherOptions.typingCallbacks.onCleanup?.();
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    try {
      setSignalRuntime({
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              agentId: "agent-1",
              sessionKey: "session-1",
              mainSessionKey: "main-session-1",
              accountId: "default",
            }),
          },
          reply: {
            formatInboundEnvelope: ({ body }: { body: string }) => body,
            resolveEnvelopeFormatOptions: () => undefined,
            finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
            dispatchReplyWithBufferedBlockDispatcher,
            resolveHumanDelayConfig: () => undefined,
          },
          session: {
            resolveStorePath: () => "/tmp/store.json",
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: async () => {},
          },
          text: {
            hasControlCommand: () => false,
          },
          debounce: {
            resolveInboundDebounceMs: () => 0,
            createInboundDebouncer: ({ onFlush }: { onFlush: (items: unknown[]) => Promise<void> }) => ({
              enqueue: async (item: unknown) => {
                await onFlush([item]);
              },
              flushKey: async () => {},
            }),
          },
          mentions: {
            buildMentionRegexes: () => [],
            matchesMentionPatterns: () => false,
          },
          groups: {
            resolveGroupPolicy: () => ({
              allowed: false,
              groupConfig: undefined,
              defaultConfig: undefined,
            }),
            resolveRequireMention: () => false,
          },
          pairing: {
            readAllowFromStore: async () => [],
            upsertPairingRequest: async () => undefined,
            buildPairingReply: () => "",
          },
        },
        system: {
          enqueueSystemEvent: vi.fn(),
        },
        media: {
          mediaKindFromMime: () => undefined,
        },
        logging: {
          shouldLogVerbose: () => false,
          getChildLogger: () =>
            ({
              info: () => {},
              warn: () => {},
              error: () => {},
            }),
        },
      } as never);

      const handler = createSignalEventHandler({
        runtime: {
          log: () => {},
          error: () => {},
          exit: () => {},
        },
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15559990000",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
        baseUrl: "http://signal.local",
        account: "+15559990000",
        accountId: "default",
        historyLimit: 0,
        groupHistories: new Map(),
        textLimit: 4000,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupAllowFrom: [],
        groupPolicy: "allowlist",
        reactionMode: "own",
        reactionAllowlist: [],
        mediaMaxBytes: 8 * 1024 * 1024,
        ignoreAttachments: false,
        sendReadReceipts: false,
        readReceiptsViaDaemon: false,
        fetchAttachment: async () => null,
        deliverReplies: async () => {},
        resolveSignalReactionTargets: () => [],
        isSignalReactionMessage: isReactionMessage,
        shouldEmitSignalReactionNotification: () => false,
        buildSignalReactionSystemEventText: () => "",
      });

      await handler({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Kai",
            timestamp: 1700000000000,
            dataMessage: {
              message: "hello",
            },
          },
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(firstBody.params.stop).toBeUndefined();
      expect(secondBody.params).toEqual(
        expect.objectContaining({
          account: "+15559990000",
          recipient: ["+15550001111"],
          stop: true,
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("dispatches inbound messages with signal-custom context", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
      expect(ctx.Provider).toBe("signal-custom");
      expect(ctx.Surface).toBe("signal-custom");
      expect(ctx.OriginatingChannel).toBe("signal-custom");
      expect(ctx.From).toBe("signal-custom:+15550001111");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const recordInboundSession = vi.fn(async (..._args: unknown[]) => {});
    const enqueueSystemEvent = vi.fn();

    setSignalRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "session-1",
            mainSessionKey: "main-session-1",
            accountId: "default",
          }),
        },
        reply: {
          formatInboundEnvelope: ({ body }: { body: string }) => body,
          resolveEnvelopeFormatOptions: () => undefined,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher,
          resolveHumanDelayConfig: () => undefined,
        },
        session: {
          resolveStorePath: () => "/tmp/store.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession,
        },
        text: {
          hasControlCommand: () => false,
        },
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: ({ onFlush }: { onFlush: (items: unknown[]) => Promise<void> }) => ({
            enqueue: async (item: unknown) => {
              await onFlush([item]);
            },
            flushKey: async () => {},
          }),
        },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        groups: {
          resolveGroupPolicy: () => ({
            allowed: false,
            groupConfig: undefined,
            defaultConfig: undefined,
          }),
          resolveRequireMention: () => false,
        },
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => undefined,
          buildPairingReply: () => "",
        },
      },
      system: {
        enqueueSystemEvent,
      },
      media: {
        mediaKindFromMime: () => undefined,
      },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () =>
          ({
            info: () => {},
            warn: () => {},
            error: () => {},
          }),
      },
    } as never);

    const handler = createSignalEventHandler({
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
          },
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      reactionMode: "own",
      reactionAllowlist: [],
      mediaMaxBytes: 8 * 1024 * 1024,
      ignoreAttachments: false,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: isReactionMessage,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
          },
        },
      }),
    });

    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not overwrite main-session routing when dmScope is isolated", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
      expect(ctx.Provider).toBe("signal-custom");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const recordInboundSession = vi.fn(async () => {});

    setSignalRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "signal-custom:peer:+15550001111",
            mainSessionKey: "main-session-1",
            accountId: "default",
          }),
        },
        reply: {
          formatInboundEnvelope: ({ body }: { body: string }) => body,
          resolveEnvelopeFormatOptions: () => undefined,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher,
          resolveHumanDelayConfig: () => undefined,
        },
        session: {
          resolveStorePath: () => "/tmp/store.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession,
        },
        text: {
          hasControlCommand: () => false,
        },
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: ({ onFlush }: { onFlush: (items: unknown[]) => Promise<void> }) => ({
            enqueue: async (item: unknown) => {
              await onFlush([item]);
            },
            flushKey: async () => {},
          }),
        },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        groups: {
          resolveGroupPolicy: () => ({
            allowed: false,
            groupConfig: undefined,
            defaultConfig: undefined,
          }),
          resolveRequireMention: () => false,
        },
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => undefined,
          buildPairingReply: () => "",
        },
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      media: {
        mediaKindFromMime: () => undefined,
      },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () =>
          ({
            info: () => {},
            warn: () => {},
            error: () => {},
          }),
      },
    } as never);

    const handler = createSignalEventHandler({
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
          },
        },
        session: {
          dmScope: "per-channel-peer",
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      reactionMode: "own",
      reactionAllowlist: [],
      mediaMaxBytes: 8 * 1024 * 1024,
      ignoreAttachments: false,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: isReactionMessage,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
          },
        },
      }),
    });

    expect(recordInboundSession).toHaveBeenCalledOnce();
    const firstRecordCall = (recordInboundSession.mock.calls as unknown[][]).at(0);
    expect(
      (firstRecordCall?.[0] as { updateLastRoute?: Record<string, unknown> } | undefined)
        ?.updateLastRoute,
    ).toBeUndefined();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("routes reaction-only inbound through system events", async () => {
    const enqueueSystemEvent = vi.fn();

    setSignalRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "session-1",
            mainSessionKey: "main-session-1",
            accountId: "default",
          }),
        },
        reply: {
          formatInboundEnvelope: ({ body }: { body: string }) => body,
          resolveEnvelopeFormatOptions: () => undefined,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
          resolveHumanDelayConfig: () => undefined,
        },
        session: {
          resolveStorePath: () => "/tmp/store.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
        text: {
          hasControlCommand: () => false,
        },
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({
            enqueue: async () => {},
            flushKey: async () => {},
          }),
        },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        groups: {
          resolveGroupPolicy: () => ({
            allowed: false,
            groupConfig: undefined,
            defaultConfig: undefined,
          }),
          resolveRequireMention: () => false,
        },
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => undefined,
          buildPairingReply: () => "",
        },
      },
      system: {
        enqueueSystemEvent,
      },
      media: {
        mediaKindFromMime: () => undefined,
      },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () =>
          ({
            info: () => {},
            warn: () => {},
            error: () => {},
          }),
      },
    } as never);

    const handler = createSignalEventHandler({
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
          },
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      reactionMode: "all",
      reactionAllowlist: [],
      mediaMaxBytes: 8 * 1024 * 1024,
      ignoreAttachments: false,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: (reaction) => [
        { kind: "phone", id: String(reaction.targetAuthor), display: String(reaction.targetAuthor) },
      ],
      isSignalReactionMessage: isReactionMessage,
      shouldEmitSignalReactionNotification: () => true,
      buildSignalReactionSystemEventText: () => "reaction system event",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          reactionMessage: {
            emoji: "✅",
            targetAuthor: "+15559990000",
            targetSentTimestamp: 1700000000000,
          },
        },
      }),
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "reaction system event",
      expect.objectContaining({
        sessionKey: "session-1",
        contextKey: expect.stringContaining("signal-custom:reaction:added"),
      }),
    );
  });
});
