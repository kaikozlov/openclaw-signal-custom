import { describe, expect, it } from "vitest";
import {
  SignalConfigSchema,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  resolveSignalMarkdownTableMode,
} from "./config.js";
import {
  looksLikeSignalCustomTargetId,
  normalizeSignalCustomMessagingTarget,
} from "./targets.js";

describe("signal-custom config", () => {
  it("accepts standalone signal-custom transport and action fields", () => {
    const parsed = SignalConfigSchema.safeParse({
      account: "+15550001111",
      httpUrl: "http://signal.local",
      ackReaction: "👀",
      configPath: "/tmp/signal-cli-config",
      tcpHost: "127.0.0.1",
      tcpPort: 7583,
      sseIdleTimeoutMs: 0,
      injectLinkPreviews: true,
      preserveTextStyles: true,
      retry: {
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 10,
        jitter: 0,
      },
      actions: {
        reactions: true,
        unsend: true,
        poll: true,
        editMessage: true,
        deleteMessage: true,
        stickers: true,
        groupManagement: true,
      },
      groups: {
        "*": {
          requireMention: false,
          tools: { allow: ["message"] },
          toolsBySender: {
            "id:user-123": { deny: ["exec"] },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("resolves accounts from channels.signal-custom", () => {
    const cfg = {
      channels: {
        "signal-custom": {
          defaultAccount: "Work",
          account: "+15550001111",
          accounts: {
            Work: {
              account: "+15550002222",
              httpUrl: "http://signal-work.local",
              configPath: "/tmp/signal-work",
              tcpHost: "127.0.0.1",
              tcpPort: 7583,
            },
          },
        },
      },
    } as const;

    expect(listSignalAccountIds(cfg as never)).toEqual(["Work"]);
    expect(resolveDefaultSignalAccountId(cfg as never)).toBe("work");
    expect(
      resolveSignalAccount({
        cfg: cfg as never,
        accountId: "work",
      }),
    ).toEqual(
      expect.objectContaining({
        accountId: "work",
        baseUrl: "http://signal-work.local",
        config: expect.objectContaining({
          configPath: "/tmp/signal-work",
        }),
        tcpHost: "127.0.0.1",
        tcpPort: 7583,
        configured: true,
      }),
    );
  });

  it("defaults signal-custom tables to bullets and respects overrides", () => {
    expect(
      resolveSignalMarkdownTableMode({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
            },
          },
        } as never,
      }),
    ).toBe("bullets");

    expect(
      resolveSignalMarkdownTableMode({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              markdown: { tables: "code" },
              accounts: {
                Work: {
                  markdown: {},
                },
              },
            },
          },
        } as never,
        accountId: "work",
      }),
    ).toBe("code");

    expect(
      resolveSignalMarkdownTableMode({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
              httpUrl: "http://signal.local",
              markdown: { tables: "code" },
              accounts: {
                Work: {
                  markdown: { tables: "off" },
                },
              },
            },
          },
        } as never,
        accountId: "work",
      }),
    ).toBe("off");
  });

  it("accepts signal-custom target prefixes", () => {
    expect(normalizeSignalCustomMessagingTarget("signal-custom:+15550001111")).toBe("+15550001111");
    expect(normalizeSignalCustomMessagingTarget("signal-custom:group:grp-1")).toBe("group:grp-1");
    expect(looksLikeSignalCustomTargetId("signal-custom:+15550001111")).toBe(true);
  });
});
