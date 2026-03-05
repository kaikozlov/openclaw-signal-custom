import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { setSignalRuntime } from "../runtime.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

function isReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  return Boolean(
    reaction?.emoji &&
      typeof reaction.targetSentTimestamp === "number" &&
      (reaction.targetAuthor || reaction.targetAuthorUuid),
  );
}

function installRuntime() {
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
      reaction.targetAuthor
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
});
