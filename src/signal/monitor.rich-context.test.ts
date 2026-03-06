import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type { SignalReactionMessage } from "./monitor/event-handler.types.js";

function isNeverSignalReaction(
  _reaction: SignalReactionMessage | null | undefined,
): _reaction is SignalReactionMessage {
  return false;
}

function installRuntime(overrides?: {
  hasControlCommand?: (text: string) => boolean;
  matchesMentionPatterns?: (text: string) => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
    async ({ ctx }: { ctx: Record<string, unknown> }) => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      ctx,
    }),
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
        hasControlCommand: (text: string) => overrides?.hasControlCommand?.(text) ?? false,
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
        matchesMentionPatterns: (text: string) => overrides?.matchesMentionPatterns?.(text) ?? false,
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

  return { dispatchReplyWithBufferedBlockDispatcher };
}

function createHandler(overrides: Partial<Parameters<typeof createSignalEventHandler>[0]> = {}) {
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
    reactionMode: "off" as const,
    reactionAllowlist: [],
    mediaMaxBytes: 8 * 1024 * 1024,
    ignoreAttachments: false,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: isNeverSignalReaction,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "",
    ...overrides,
  });
}

function makeReceiveEvent(dataMessage: Record<string, unknown>, envelope?: Record<string, unknown>) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Kai",
        timestamp: 1700000000000,
        dataMessage,
        ...envelope,
      },
    }),
  };
}

function capturedCtx(spy: ReturnType<typeof vi.fn>) {
  return (spy.mock.calls[0]?.[0] as { ctx?: Record<string, unknown> } | undefined)?.ctx;
}

describe("signal monitor rich inbound context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies text styles and link previews by default", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
        previews: [
          {
            url: "https://example.com/post",
            title: "Example Post",
            description: "A useful summary",
          },
        ],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("**hello** _world_");
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        "Link preview: Example Post - A useful summary (https://example.com/post)",
      ]),
    );
  });

  it("uses plain text for control-command detection while preserving styled text in context", async () => {
    let seenText = "";
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      hasControlCommand: (text) => {
        seenText = text;
        return false;
      },
    });
    const handler = createHandler();

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [{ style: "MONOSPACE", start: 0, length: 5 }],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(seenText).toBe("hello world");
    expect(ctx?.BodyForCommands).toBe("`hello` world");
  });

  it("keeps text styles when link previews are disabled", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler({
      injectLinkPreviews: false,
      preserveTextStyles: true,
    });

    await handler(
      makeReceiveEvent({
        message: "styled text",
        textStyles: [{ style: "BOLD", start: 0, length: 6 }],
        previews: [{ url: "https://hidden.example", title: "Hidden" }],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("**styled** text");
    expect(ctx?.UntrustedContext).toBeUndefined();
  });

  it("keeps link previews when text style preservation is disabled", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler({
      injectLinkPreviews: true,
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "plain text",
        textStyles: [{ style: "BOLD", start: 0, length: 5 }],
        previews: [{ url: "https://example.com", title: "Example" }],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("plain text");
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining(["Link preview: Example (https://example.com)"]),
    );
  });

  it("adjusts style offsets after mention expansion", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler(
      makeReceiveEvent({
        message: "\uFFFC check this out",
        mentions: [
          {
            uuid: "550e8400-e29b-41d4-a716-446655440000",
            start: 0,
            length: 1,
          },
        ],
        textStyles: [{ style: "BOLD", start: 2, length: 5 }],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe(
      "@550e8400-e29b-41d4-a716-446655440000 **check** this out",
    );
  });

  it("captures sticker placeholders, media, and metadata", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const fetchAttachment = vi.fn(async () => ({
      path: "/tmp/sticker.webp",
      contentType: "image/webp",
    }));
    const handler = createHandler({ fetchAttachment });

    await handler(
      makeReceiveEvent({
        sticker: {
          packId: "signal-pack-1",
          stickerId: 42,
          attachment: {
            id: "sticker-att-1",
            contentType: "image/webp",
          },
        },
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("<media:sticker>");
    expect(ctx?.MediaPath).toBe("/tmp/sticker.webp");
    expect(ctx?.MediaPaths).toEqual(["/tmp/sticker.webp"]);
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        "Signal sticker packId: signal-pack-1",
        "Signal stickerId: 42",
      ]),
    );
  });

  it("captures shared contacts as placeholder plus untrusted context", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler(
      makeReceiveEvent({
        contacts: [
          {
            name: { display: "Jane Doe" },
            phone: [{ value: "+15551234567" }],
            email: [{ value: "jane@example.com" }],
            organization: "Acme Corp",
          },
        ],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("<media:contact>");
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        "Shared contact: Jane Doe (+15551234567, jane@example.com, Acme Corp)",
      ]),
    );
  });

  it("captures poll creation and vote context", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const handler = createHandler();

    await handler(
      makeReceiveEvent({
        pollCreate: {
          question: "What's for lunch?",
          allowMultiple: true,
          options: ["Pizza", "Sushi", "Tacos"],
        },
      }),
    );

    let ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("[Poll] What's for lunch?");
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        'Poll: "What\'s for lunch?" — Options: Pizza, Sushi, Tacos (multiple selections allowed)',
      ]),
    );

    dispatchReplyWithBufferedBlockDispatcher.mockClear();

    await handler(
      makeReceiveEvent({
        pollVote: {
          authorNumber: "+15551234567",
          targetSentTimestamp: 1234567890,
          optionIndexes: [1, 3],
        },
      }),
    );

    ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.BodyForCommands).toBe("[Poll vote]");
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining(["Poll vote on #1234567890: option(s) 1, 3"]),
    );
  });

  it("threads attachment captions, dimensions, and edit target metadata", async () => {
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
          timestamp: 1700000000999,
          editMessage: {
            targetSentTimestamp: 1700000000111,
            dataMessage: {
              attachments: [
                {
                  id: "img-1",
                  contentType: "image/jpeg",
                  caption: "sunset",
                  width: 4000,
                  height: 3000,
                },
                {
                  id: "img-2",
                  contentType: "image/png",
                  caption: "mountain",
                  width: 1920,
                  height: 1080,
                },
              ],
            },
          },
        },
      }),
    });

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher) as
      | (Record<string, unknown> & {
          EditTargetTimestamp?: number;
          MediaCaption?: string;
          MediaCaptions?: string[];
          MediaDimension?: { width?: number; height?: number };
          MediaDimensions?: Array<{ width?: number; height?: number }>;
          UntrustedContext?: string[];
        })
      | undefined;
    expect(ctx?.EditTargetTimestamp).toBe(1700000000111);
    expect(ctx?.MediaCaption).toBe("sunset");
    expect(ctx?.MediaCaptions).toEqual(["sunset", "mountain"]);
    expect(ctx?.MediaDimension).toEqual({ width: 4000, height: 3000 });
    expect(ctx?.MediaDimensions).toEqual([
      { width: 4000, height: 3000 },
      { width: 1920, height: 1080 },
    ]);
    expect(ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        'Signal attachment 1: 4000x3000, "sunset"',
        'Signal attachment 2: 1920x1080, "mountain"',
        "Signal edit target: 1700000000111",
      ]),
    );
  });

  it("keeps successful attachments when another download fails", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime();
    const fetchAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ path: "/tmp/two.png", contentType: "image/png" });
    const handler = createHandler({ fetchAttachment });

    await handler(
      makeReceiveEvent({
        attachments: [
          { id: "bad", contentType: "image/jpeg" },
          { id: "good", contentType: "image/png" },
        ],
      }),
    );

    const ctx = capturedCtx(dispatchReplyWithBufferedBlockDispatcher);
    expect(ctx?.MediaPath).toBe("/tmp/two.png");
    expect(ctx?.MediaPaths).toEqual(["/tmp/two.png"]);
    expect(ctx?.MediaTypes).toEqual(["image/png"]);
  });
});
