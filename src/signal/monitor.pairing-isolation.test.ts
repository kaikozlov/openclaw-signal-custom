import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { setSignalRuntime } from "../runtime.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

const { sendMessageSignalMock, sendTypingSignalMock, sendReadReceiptSignalMock } = vi.hoisted(
  () => ({
    sendMessageSignalMock: vi.fn(async () => ({ messageId: "m1" })),
    sendTypingSignalMock: vi.fn(async () => true),
    sendReadReceiptSignalMock: vi.fn(async () => true),
  }),
);

vi.mock("./send.js", () => ({
  sendMessageSignal: sendMessageSignalMock,
  sendTypingSignal: sendTypingSignalMock,
  sendReadReceiptSignal: sendReadReceiptSignalMock,
}));

function isReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  return Boolean(
    reaction?.emoji &&
      typeof reaction.targetSentTimestamp === "number" &&
      (reaction.targetAuthor || reaction.targetAuthorUuid),
  );
}

function createBaseHandler(params?: {
  accountId?: string;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  dispatchSpy?: ReturnType<typeof vi.fn>;
  readAllowFromStoreSpy?: ReturnType<typeof vi.fn>;
  upsertPairingRequestSpy?: ReturnType<typeof vi.fn>;
}) {
  const dispatchReplyWithBufferedBlockDispatcher =
    params?.dispatchSpy ??
    vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
  const readAllowFromStore =
    params?.readAllowFromStoreSpy ?? vi.fn(async () => [] as string[]);
  const upsertPairingRequest =
    params?.upsertPairingRequestSpy ?? vi.fn(async () => ({ code: "PAIR", created: true }));

  setSignalRuntime({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent-1",
          sessionKey: "session-1",
          mainSessionKey: "main-session-1",
          accountId: params?.accountId ?? "default",
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
        readAllowFromStore,
        upsertPairingRequest,
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
      messages: {
        inbound: {
          debounceMs: 0,
        },
      },
      commands: {
        useAccessGroups: true,
      },
    } as never,
    baseUrl: "http://signal.local",
    account: "+15559990000",
    accountId: params?.accountId ?? "default",
    historyLimit: 0,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: params?.dmPolicy ?? "open",
    allowFrom: params?.allowFrom ?? ["*"],
    groupAllowFrom: params?.groupAllowFrom ?? [],
    groupPolicy: params?.groupPolicy ?? "allowlist",
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

  return {
    handler,
    dispatchReplyWithBufferedBlockDispatcher,
    readAllowFromStore,
    upsertPairingRequest,
  };
}

describe("signal pairing and allowlist isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not treat DM pairing-store entries as group allowlist authorization", async () => {
    const { handler, dispatchReplyWithBufferedBlockDispatcher, readAllowFromStore } =
      createBaseHandler({
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550002222"],
      });
    readAllowFromStore.mockResolvedValueOnce(["+15550001111"]);

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Paired DM User",
          timestamp: 1700000000100,
          dataMessage: {
            message: "hello from group",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Test Group" },
          },
        },
      }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("reads pairing allow store with account-scoped key", async () => {
    const readAllowFromStore = vi.fn(async () => ["+15550002222"]);
    const { handler, dispatchReplyWithBufferedBlockDispatcher } = createBaseHandler({
      accountId: "work",
      dmPolicy: "pairing",
      allowFrom: [],
      groupAllowFrom: [],
      readAllowFromStoreSpy: readAllowFromStore,
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550002222",
          sourceName: "Alice",
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        },
      }),
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "signal-custom",
      accountId: "work",
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });

  it("stores pairing requests with account-scoped key", async () => {
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR", created: true }));
    const { handler, dispatchReplyWithBufferedBlockDispatcher } = createBaseHandler({
      accountId: "work",
      dmPolicy: "pairing",
      allowFrom: [],
      groupAllowFrom: [],
      upsertPairingRequestSpy: upsertPairingRequest,
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550003333",
          sourceName: "Alice",
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        },
      }),
    });

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "signal-custom",
      accountId: "work",
      id: "+15550003333",
      meta: { name: "Alice" },
    });
    expect(sendMessageSignalMock).toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});
