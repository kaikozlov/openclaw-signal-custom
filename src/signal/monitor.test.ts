import { describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { setSignalRuntime } from "../runtime.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

function makeResponse(text: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
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

function installImmediateDispatchRuntime() {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  }));

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
        resolveRequireMention: () => true,
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => undefined,
        buildPairingReply: () => "",
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
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

  return { dispatchReplyWithBufferedBlockDispatcher };
}

function createGroupTestHandler(params?: {
  cfg?: Record<string, unknown>;
  allowFrom?: string[];
  groupAllowFrom?: string[];
}) {
  return createSignalEventHandler({
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
          ...(params?.cfg ?? {}),
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
    allowFrom: params?.allowFrom ?? ["*"],
    groupAllowFrom: params?.groupAllowFrom ?? [],
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
          requestHeartbeatNow: vi.fn(),
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
            sourceName: "Casey",
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

  it("drops duplicate inbound deliveries within the recent-event window", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler();
    const event = {
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1712345678901,
          dataMessage: {
            timestamp: 1712345678901,
            message: "hello once",
            attachments: [],
          },
        },
      }),
    };

    await handler(event);
    await handler(event);

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("finalizes text-only draft previews by editing the preview message", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000001000 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000001000 },
          }),
        ),
      );

    const deliverReplies = vi.fn(
      async (_params: {
        target: string;
        silent?: boolean;
      }) => {},
    );
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        replyOptions,
        dispatcherOptions,
      }: {
        replyOptions?: { onPartialReply?: (payload: { text?: string }) => Promise<void> };
        dispatcherOptions: {
          deliver: (
            payload: Record<string, unknown>,
            info: { kind: "final" | "block" | "tool" },
          ) => Promise<void>;
        };
      }) => {
        await replyOptions?.onPartialReply?.({
          text: "This is a long enough partial preview to trigger draft streaming.",
        });
        await dispatcherOptions.deliver({ text: "**Final** answer" }, { kind: "final" });
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
          requestHeartbeatNow: vi.fn(),
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
              streaming: "draft",
              retry: {
                attempts: 1,
                minDelayMs: 0,
                maxDelayMs: 0,
                jitter: 0,
              },
            },
          },
        } as never,
        baseUrl: "http://signal.local",
        account: "+15559990000",
        accountId: "default",
        streamMode: "draft",
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
        deliverReplies,
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
            sourceName: "Casey",
            timestamp: 1700000000000,
            dataMessage: {
              message: "hello",
            },
          },
        }),
      });

      expect(deliverReplies).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const previewBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      const finalBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };

      expect(previewBody.method).toBe("send");
      expect(previewBody.params).toEqual(
        expect.objectContaining({
          account: "+15559990000",
          recipient: ["+15550001111"],
          message: "This is a long enough partial preview to trigger draft streaming.",
        }),
      );
      expect(finalBody.method).toBe("send");
      expect(finalBody.params).toEqual(
        expect.objectContaining({
          account: "+15559990000",
          recipient: ["+15550001111"],
          editTimestamp: 1700000001000,
          message: "Final answer",
          "text-style": ["0:5:BOLD"],
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("marks non-final block updates silent before delivery", async () => {
    const deliverReplies = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          deliver: (
            payload: Record<string, unknown>,
            info: { kind: "final" | "block" | "tool" },
          ) => Promise<void>;
        };
      }) => {
        await dispatcherOptions.deliver({ text: "working..." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 1, final: 1 } };
      },
    );

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
        requestHeartbeatNow: vi.fn(),
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
            streaming: "block",
          },
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      streamMode: "block",
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
      deliverReplies,
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
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
          },
        },
      }),
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: "+15550001111",
        silent: true,
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: "+15550001111",
        silent: undefined,
      }),
    );
  });

  it("only marks the last answer-bearing final delivery urgent in block mode", async () => {
    const deliverReplies = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          deliver: (
            payload: Record<string, unknown>,
            info: { kind: "final" | "block" | "tool" },
          ) => Promise<void>;
        };
      }) => {
        await dispatcherOptions.deliver({ text: "alpha" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "beta" }, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
      },
    );

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
        requestHeartbeatNow: vi.fn(),
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
            streaming: "block",
          },
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      streamMode: "block",
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
      deliverReplies,
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
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
          },
        },
      }),
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: "+15550001111",
        silent: true,
        replies: [expect.objectContaining({ text: "alpha" })],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: "+15550001111",
        silent: undefined,
        replies: [expect.objectContaining({ text: "beta" })],
      }),
    );
  });

  it("disables silent intermediate deliveries when configured off", async () => {
    const deliverReplies = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          deliver: (
            payload: Record<string, unknown>,
            info: { kind: "final" | "block" | "tool" },
          ) => Promise<void>;
        };
      }) => {
        await dispatcherOptions.deliver({ text: "alpha" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "beta" }, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
      },
    );

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
        requestHeartbeatNow: vi.fn(),
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
            streaming: "block",
            silentIntermediateReplies: false,
          },
        },
      } as never,
      baseUrl: "http://signal.local",
      account: "+15559990000",
      accountId: "default",
      streamMode: "block",
      silentIntermediateReplies: false,
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
      deliverReplies,
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
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
          },
        },
      }),
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: "+15550001111",
        silent: undefined,
        replies: [expect.objectContaining({ text: "alpha" })],
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: "+15550001111",
        silent: undefined,
        replies: [expect.objectContaining({ text: "beta" })],
      }),
    );
  });

  it("falls back to normal delivery when a draft preview edit fails", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1700000001000 },
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(
        makeResponse(
          JSON.stringify({
            jsonrpc: "2.0",
            result: null,
          }),
        ),
      );

    const deliverReplies = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        replyOptions,
        dispatcherOptions,
      }: {
        replyOptions?: { onPartialReply?: (payload: { text?: string }) => Promise<void> };
        dispatcherOptions: {
          deliver: (
            payload: Record<string, unknown>,
            info: { kind: "final" | "block" | "tool" },
          ) => Promise<void>;
        };
      }) => {
        await replyOptions?.onPartialReply?.({
          text: "This is a long enough partial preview to trigger draft streaming.",
        });
        await dispatcherOptions.deliver({ text: "**Final** answer" }, { kind: "final" });
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
          requestHeartbeatNow: vi.fn(),
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
              streaming: "draft",
              retry: {
                attempts: 1,
                minDelayMs: 0,
                maxDelayMs: 0,
                jitter: 0,
              },
            },
          },
        } as never,
        baseUrl: "http://signal.local",
        account: "+15559990000",
        accountId: "default",
        streamMode: "draft",
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
        deliverReplies,
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
            sourceName: "Casey",
            timestamp: 1700000000000,
            dataMessage: {
              message: "hello",
            },
          },
        }),
      });

      expect(deliverReplies).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const cleanupBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      expect(cleanupBody.method).toBe("remoteDelete");
      expect(cleanupBody.params).toEqual(
        expect.objectContaining({
          account: "+15559990000",
          recipient: ["+15550001111"],
          targetTimestamp: 1700000001000,
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("allows distinct or expired inbound messages from the same sender", async () => {
    const nowMock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(32_500)
      .mockReturnValueOnce(32_500)
      .mockReturnValueOnce(33_000)
      .mockReturnValueOnce(33_000);
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler();
    const duplicateAfterExpiry = {
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1712345678901,
          dataMessage: {
            timestamp: 1712345678901,
            message: "first message",
            attachments: [],
          },
        },
      }),
    };
    const distinctMessage = {
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1712345678902,
          dataMessage: {
            timestamp: 1712345678902,
            message: "second message",
            attachments: [],
          },
        },
      }),
    };

    try {
      await handler(duplicateAfterExpiry);
      await handler(duplicateAfterExpiry);
      await handler(distinctMessage);
    } finally {
      nowMock.mockRestore();
    }

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
  });

  it("uses configured typing TTL for Signal typing callbacks", async () => {
    vi.useFakeTimers();
    const originalWarn = console.warn;
    const warnMock = vi.fn();
    console.warn = warnMock;
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
          };
        };
      }) => {
        await dispatcherOptions.typingCallbacks.onReplyStart();
        await vi.advanceTimersByTimeAsync(5);
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
          requestHeartbeatNow: vi.fn(),
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
              typingTtlMs: 5,
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
            sourceName: "Casey",
            timestamp: 1700000000000,
            dataMessage: {
              message: "hello",
            },
          },
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
        params: Record<string, unknown>;
      };
      expect(secondBody.params.stop).toBe(true);
      expect(warnMock).toHaveBeenCalledWith("[typing] TTL exceeded (5ms), auto-stopping typing indicator");
    } finally {
      console.warn = originalWarn;
      global.fetch = originalFetch;
      vi.useRealTimers();
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
          sourceName: "Casey",
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
          sourceName: "Casey",
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
    const requestHeartbeatNow = vi.fn();

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
        requestHeartbeatNow,
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
          sourceName: "Casey",
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
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("blocks inbound messages for groups disabled via per-group config", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          grp1: {
            enabled: false,
          },
        },
      },
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp1", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses exact per-group allowFrom overrides instead of account-level groupAllowFrom", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          grp1: {
            allowFrom: ["+15550001111"],
            requireMention: false,
          },
        },
      },
      groupAllowFrom: ["+15550002222"],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp1", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("uses wildcard per-group allowFrom overrides for unmatched groups", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          "*": {
            allowFrom: ["+15550001111"],
            requireMention: false,
          },
        },
      },
      groupAllowFrom: ["+15550002222"],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp2", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("does not treat decorative per-group config as implicit allowlist access", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          grp1: {
            requireMention: false,
            skills: ["message"],
            systemPrompt: "Stay focused.",
          },
        },
      },
      allowFrom: [],
      groupAllowFrom: [],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp1", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not treat wildcard decorative group config as implicit allowlist access", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          "*": {
            requireMention: false,
            systemPrompt: "Stay focused.",
          },
        },
      },
      allowFrom: [],
      groupAllowFrom: [],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp2", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("passes per-group skills through replyOptions as skillFilter", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installImmediateDispatchRuntime();
    const handler = createGroupTestHandler({
      cfg: {
        groups: {
          grp1: {
            requireMention: false,
            skills: ["message", "search"],
          },
        },
      },
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Casey",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: { groupId: "grp1", groupName: "Ops" },
          },
        },
      }),
    });

    const firstDispatchCall = (dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown[][])[0]?.[0];
    expect(firstDispatchCall).toBeDefined();
    expect(
      (firstDispatchCall as unknown as { replyOptions?: { skillFilter?: string[] } }).replyOptions
        ?.skillFilter,
    ).toEqual(["message", "search"]);
  });
});
