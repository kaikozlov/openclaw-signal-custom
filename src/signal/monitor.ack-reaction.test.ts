import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./send-reactions.js", () => ({
  sendReactionSignal: vi.fn().mockResolvedValue({ ok: true }),
}));

import { setSignalRuntime } from "../runtime.js";
import { sendReactionSignal } from "./send-reactions.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
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

function installRuntime(params?: {
  dispatchReplyWithBufferedBlockDispatcher?: (args: { ctx: Record<string, unknown> }) => Promise<{
    queuedFinal: boolean;
    counts: { tool: number; block: number; final: number };
  }>;
  buildMentionRegexes?: () => RegExp[];
  matchesMentionPatterns?: (text: string, patterns: RegExp[]) => boolean;
  resolveRequireMention?: () => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher =
    params?.dispatchReplyWithBufferedBlockDispatcher ??
    (async () => ({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } }));
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
        recordInboundSession: vi.fn(async () => {}),
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
        buildMentionRegexes: params?.buildMentionRegexes ?? (() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? (() => false),
      },
      groups: {
        resolveGroupPolicy: () => ({
          allowed: false,
          groupConfig: undefined,
          defaultConfig: undefined,
        }),
        resolveRequireMention: params?.resolveRequireMention ?? (() => false),
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
      mediaKindFromMime: (mime?: string) => {
        if (mime?.startsWith("image/")) {
          return "image";
        }
        if (mime?.startsWith("audio/")) {
          return "audio";
        }
        return undefined;
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
}

function createHandler(params?: {
  cfg?: Record<string, unknown>;
  ignoreAttachments?: boolean;
  fetchAttachment?: (params: {
    baseUrl: string;
    account?: string;
    maxBytes: number;
  }) => Promise<{ path: string; contentType?: string } | null>;
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
          accounts: {
            default: {
              reactionLevel: "ack",
            },
          },
        },
      },
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
      },
      ...params?.cfg,
    } as never,
    baseUrl: "http://signal.local",
    account: "+15559990000",
    accountUuid: "signal-bot-uuid",
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
    ignoreAttachments: params?.ignoreAttachments ?? false,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment:
      params?.fetchAttachment ??
      (async () => ({
        path: "/tmp/signal-media.png",
        contentType: "image/png",
      })),
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: isReactionMessage,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "",
  });
}

function createReceiveEvent(params?: {
  envelopeTimestamp?: number;
  dataMessage?: Record<string, unknown>;
}) {
  const envelopeTimestamp =
    params && "envelopeTimestamp" in params ? params.envelopeTimestamp : 1700000000000;
  const dataMessage = {
    message: "hello",
    timestamp: 1700000000000,
    ...params?.dataMessage,
  };
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceUuid: "sender-uuid-1",
        sourceName: "Kai",
        timestamp: envelopeTimestamp,
        dataMessage,
      },
    }),
  };
}

describe("signal ack reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
  });

  it("sends ack reaction for direct messages when reactionLevel=ack and scope=direct", async () => {
    const handler = createHandler({
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "direct",
        },
      },
    });

    await handler(createReceiveEvent());

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({
        accountId: "default",
        targetAuthor: "+15550001111",
        targetAuthorUuid: "sender-uuid-1",
      }),
    );
  });

  it("sends group ack reactions when mention metadata satisfies group-mentions scope", async () => {
    installRuntime({
      resolveRequireMention: () => true,
    });
    const handler = createHandler({
      cfg: {
        messages: {
          ackReaction: "✅",
          ackReactionScope: "group-mentions",
        },
      },
    });

    await handler(
      createReceiveEvent({
        dataMessage: {
          message: "hello group",
          groupInfo: {
            groupId: "grp-1",
            groupName: "Test Group",
          },
          mentions: [{ number: "+15559990000" }],
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "✅",
      expect.objectContaining({
        groupId: "grp-1",
        targetAuthor: "+15550001111",
        targetAuthorUuid: "sender-uuid-1",
      }),
    );
  });

  it("does not send ack reactions when scope is off", async () => {
    const handler = createHandler({
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "off",
        },
      },
    });

    await handler(createReceiveEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does not send ack reactions when reactionLevel is not ack", async () => {
    const handler = createHandler({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15559990000",
            accounts: {
              default: {
                reactionLevel: "minimal",
              },
            },
          },
        },
      },
    });

    await handler(createReceiveEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does not send ack reactions when no usable timestamp exists", async () => {
    const handler = createHandler();

    await handler(
      createReceiveEvent({
        envelopeTimestamp: undefined,
        dataMessage: {
          message: "hello",
          timestamp: undefined,
        },
      }),
    );

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does not ack ignored attachment-only messages", async () => {
    const handler = createHandler({
      ignoreAttachments: true,
    });

    await handler(
      createReceiveEvent({
        dataMessage: {
          message: "",
          attachments: [{ id: "att-1", contentType: "image/png" }],
        },
      }),
    );

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("sends ack before reply dispatch starts", async () => {
    const callOrder: string[] = [];
    vi.mocked(sendReactionSignal).mockImplementation(async () => {
      callOrder.push("ack");
      return { ok: true };
    });
    installRuntime({
      dispatchReplyWithBufferedBlockDispatcher: async () => {
        callOrder.push("dispatch");
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    });
    const handler = createHandler();

    await handler(createReceiveEvent());

    expect(callOrder).toEqual(["ack", "dispatch"]);
  });
});
