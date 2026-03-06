import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { setSignalRuntime } from "../runtime.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

function isReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  if (!reaction?.emoji) {
    return false;
  }
  const timestamp =
    typeof reaction.targetSentTimestamp === "number"
      ? reaction.targetSentTimestamp
      : typeof reaction.targetSentTimestamp === "string"
        ? Number(reaction.targetSentTimestamp)
        : Number.NaN;
  return Boolean(
    Number.isFinite(timestamp) &&
      timestamp > 0 &&
      (reaction.targetAuthor ||
        reaction.targetAuthorUuid ||
        reaction.targetAuthorNumber ||
        reaction.targetAuthorE164 ||
        reaction.targetAuthorPhone ||
        reaction.remove === true ||
        reaction.isRemove === true),
  );
}

function installRuntime(overrides?: {
  hasControlCommand?: boolean;
  buildMentionRegexes?: () => RegExp[];
  matchesMentionPatterns?: () => boolean;
  resolveGroupPolicy?: () => {
    allowed: boolean;
    groupConfig?: Record<string, unknown>;
    defaultConfig?: Record<string, unknown>;
  };
  resolveRequireMention?: () => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => ({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
    ctx,
  }));
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
        recordInboundSession: async () => {},
      },
      text: {
        hasControlCommand: () => overrides?.hasControlCommand === true,
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
        buildMentionRegexes: overrides?.buildMentionRegexes ?? (() => []),
        matchesMentionPatterns: overrides?.matchesMentionPatterns ?? (() => false),
      },
      groups: {
        resolveGroupPolicy:
          overrides?.resolveGroupPolicy ??
          (() => ({
            allowed: false,
            groupConfig: undefined,
            defaultConfig: undefined,
          })),
        resolveRequireMention: overrides?.resolveRequireMention ?? (() => false),
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
      mediaKindFromMime: (mime?: string | null) => {
        if (!mime) {
          return "unknown";
        }
        if (mime.startsWith("image/")) {
          return "image";
        }
        if (mime.startsWith("audio/")) {
          return "audio";
        }
        if (mime.startsWith("video/")) {
          return "video";
        }
        return "unknown";
      },
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

  return {
    dispatchReplyWithBufferedBlockDispatcher,
    enqueueSystemEvent,
  };
}

function createHandler(overrides: Partial<Parameters<typeof createSignalEventHandler>[0]> = {}) {
  const runtime = {
    log: () => {},
    error: () => {},
    exit: () => {},
  };
  const baseDeps = {
    runtime,
    cfg: {
      channels: {
        "signal-custom": {
          account: "+15559990000",
        },
      },
      messages: {
        inbound: {
          debounceMs: 0,
        },
      },
    } as never,
    baseUrl: "http://signal.local",
    account: "+15559990000",
    accountId: "default",
    historyLimit: 0,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open" as const,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "allowlist" as const,
    reactionMode: "own" as const,
    reactionAllowlist: [],
    mediaMaxBytes: 8 * 1024 * 1024,
    ignoreAttachments: false,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: (reaction: SignalReactionMessage) =>
      typeof reaction.targetAuthor === "string"
        ? [{ kind: "phone" as const, id: reaction.targetAuthor, display: reaction.targetAuthor }]
        : [],
    isSignalReactionMessage: isReactionMessage,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: (params: {
      emojiLabel: string;
      actorLabel: string;
      messageId: string;
    }) => `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`,
  };
  return createSignalEventHandler({
    ...baseDeps,
    ...overrides,
  });
}

describe("signal monitor edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts group envelopes when syncMessage is present but null", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          syncMessage: null,
          dataMessage: {
            message: "group hello",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as { ctx: { ChatType?: string } }).ctx.ChatType,
    ).toBe("group");
  });

  it("accepts group dataMessage even when syncMessage object exists", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          syncMessage: { sentMessage: { destination: "+15550003333" } },
          dataMessage: {
            message: "group hello",
            attachments: [],
            groupInfo: { groupId: "g-sync", groupName: "Sync Group" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as { ctx: { GroupSubject?: string } }).ctx.GroupSubject,
    ).toBe("Sync Group");
  });

  it("captures all inbound attachments and preserves media arrays", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const fetchAttachment = vi
      .fn()
      .mockResolvedValueOnce({ path: "/tmp/one.jpg", contentType: "image/jpeg" })
      .mockResolvedValueOnce({ path: "/tmp/two.png", contentType: "image/png" });
    const handler = createHandler({ fetchAttachment });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            attachments: [
              { id: "a1", contentType: "image/jpeg" },
              { id: "a2", contentType: "image/png" },
            ],
          },
        },
      }),
    });

    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
        ctx: {
          MediaPath?: string;
          MediaType?: string;
          MediaPaths?: string[];
          MediaTypes?: string[];
          MediaUrls?: string[];
        };
      }).ctx,
    ).toEqual(
      expect.objectContaining({
        MediaPath: "/tmp/one.jpg",
        MediaType: "image/jpeg",
        MediaPaths: ["/tmp/one.jpg", "/tmp/two.png"],
        MediaTypes: ["image/jpeg", "image/png"],
        MediaUrls: ["/tmp/one.jpg", "/tmp/two.png"],
      }),
    );
  });

  it("authorizes control commands from explicitly allowed groups", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      hasControlCommand: true,
      resolveGroupPolicy: () => ({
        allowed: true,
        groupConfig: { allowFrom: [] },
        defaultConfig: undefined,
      }),
    });
    const handler = createHandler({
      allowFrom: [],
      groupAllowFrom: [],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            message: "/status",
            groupInfo: { groupId: "g-ops", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
        ctx: { CommandAuthorized?: boolean };
      }).ctx.CommandAuthorized,
    ).toBe(true);
  });

  it("uses mention metadata when regex patterns are absent", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      resolveRequireMention: () => true,
    });
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            message: `hello \uFFFC`,
            mentions: [
              {
                number: "+15559990000",
                start: 6,
                length: 1,
              },
            ],
            groupInfo: { groupId: "g-mention", groupName: "Mention Group" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
        ctx: { WasMentioned?: boolean };
      }).ctx.WasMentioned,
    ).toBe(true);
  });

  it("passes quote context through to inbound ctx when Signal quote metadata is present", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Kai",
          timestamp: 1700000000000,
          dataMessage: {
            message: "I agree",
            quote: {
              id: 1699999990000,
              author: "+15550009999",
              text: "Original quoted message",
            },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(
      (dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0] as {
        ctx: {
          ReplyToId?: string;
          ReplyToBody?: string;
          ReplyToSender?: string;
          ReplyToIsQuote?: boolean;
        };
      }).ctx,
    ).toEqual(
      expect.objectContaining({
        ReplyToId: "1699999990000",
        ReplyToBody: "Original quoted message",
        ReplyToSender: "+15550009999",
        ReplyToIsQuote: true,
      }),
    );
  });

  it("filters expiration timer and group change system messages", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          dataMessage: {
            message: null,
            attachments: [],
            expiresInSeconds: 604800,
            groupInfo: { groupId: "g1", groupName: "Ops" },
          },
        },
      }),
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          dataMessage: {
            message: null,
            attachments: [],
            groupV2Change: { editor: "+15550001111", changes: [] },
            groupInfo: { groupId: "g1", groupName: "Ops" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("surfaces bare reactions as system events instead of dispatching media placeholders", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, enqueueSystemEvent } = installRuntime();
    const handler = createHandler({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          dataMessage: {
            message: "",
            reaction: {
              emoji: "👍",
              isRemove: false,
              targetSentTimestamp: 1699999000000,
            },
            attachments: [{ id: "thumb1", contentType: null, size: 0 }],
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("👍"),
      expect.objectContaining({
        contextKey: expect.stringContaining("signal-custom:reaction:added"),
      }),
    );
  });

  it("ignores reaction removals that use the remove field", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, enqueueSystemEvent } = installRuntime();
    const handler = createHandler({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
      resolveSignalReactionTargets: () => [
        { kind: "phone", id: "+15550002222", display: "+15550002222" },
      ],
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          reactionMessage: {
            emoji: "✅",
            targetAuthorNumber: "+15550002222",
            targetSentTimestamp: "2",
            remove: true,
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("emits system events for edit/delete/pin/unpin control envelopes", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, enqueueSystemEvent } = installRuntime();
    const handler = createHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000001234,
          editMessage: {
            targetSentTimestamp: 1700000000001,
            dataMessage: {
              message: "edited body",
            },
          },
        },
      }),
    });
    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          dataMessage: {
            remoteDelete: {
              timestamp: 1700000000002,
            },
          },
        },
      }),
    });
    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000001236,
          dataMessage: {
            pinMessage: {
              targetSentTimestamp: 1700000000003,
            },
          },
        },
      }),
    });
    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000001237,
          dataMessage: {
            unpinMessage: {
              targetSentTimestamp: 1700000000004,
            },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    const texts = enqueueSystemEvent.mock.calls.map((call) => String(call[0]));
    expect(texts.some((text) => text.includes("Signal message edited:"))).toBe(true);
    expect(texts.some((text) => text.includes("Signal message deleted:"))).toBe(true);
    expect(texts.some((text) => text.includes("Signal message pinned:"))).toBe(true);
    expect(texts.some((text) => text.includes("Signal message unpinned:"))).toBe(true);
  });

  it("does not crash on bare reactions with non-string emoji payloads", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, enqueueSystemEvent } = installRuntime();
    const handler = createHandler({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
    });

    await expect(
      handler({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Alice",
            dataMessage: {
              message: "",
              reaction: {
                emoji: 7,
                isRemove: false,
                targetSentTimestamp: 1699999000000,
              },
            },
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("emoji"),
      expect.objectContaining({
        contextKey: expect.stringContaining("signal-custom:reaction:added"),
      }),
    );
  });
});
