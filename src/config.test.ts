import { describe, expect, it } from "vitest";
import {
  SignalConfigSchema,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  resolveSignalMarkdownTableMode,
  resolveSignalStreamingMode,
} from "./config.js";
import { signalCustomConfigAdapter, signalCustomSecurityAdapter } from "./shared.js";
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
      typingTtlMs: 30000,
      injectLinkPreviews: true,
      preserveTextStyles: true,
      retry: {
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 10,
        jitter: 0,
      },
      reconnect: {
        initialMs: 100,
        maxMs: 1000,
        factor: 2,
        jitter: 0.1,
        maxAttempts: 4,
      },
      supervision: {
        initialMs: 250,
        maxMs: 2000,
        factor: 1.5,
        jitter: 0,
        maxAttempts: 3,
        drainGraceMs: 500,
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

  it("resolves signal-custom typing TTL with account override precedence", () => {
    const cfg = {
      channels: {
        "signal-custom": {
          account: "+15550001111",
          typingTtlMs: 30000,
          accounts: {
            Work: {
              account: "+15550002222",
              httpUrl: "http://signal-work.local",
              typingTtlMs: 90000,
            },
          },
        },
      },
    } as const;

    expect(
      resolveSignalAccount({
        cfg: cfg as never,
        accountId: "default",
      }).config.typingTtlMs,
    ).toBe(30000);
    expect(
      resolveSignalAccount({
        cfg: cfg as never,
        accountId: "work",
      }).config.typingTtlMs,
    ).toBe(90000);
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

  it("resolves explicit stream modes while preserving blockStreaming compatibility", () => {
    expect(
      resolveSignalStreamingMode({
        cfg: {
          channels: {
            "signal-custom": {
              blockStreaming: false,
            },
          },
        } as never,
      }),
    ).toBe("off");

    expect(
      resolveSignalStreamingMode({
        cfg: {
          channels: {
            "signal-custom": {
              blockStreaming: false,
              accounts: {
                Work: {
                  streaming: "draft",
                },
              },
            },
          },
        } as never,
        accountId: "work",
      }),
    ).toBe("draft");

    expect(
      resolveSignalStreamingMode({
        cfg: {
          channels: {
            "signal-custom": {},
          },
        } as never,
      }),
    ).toBe("block");
  });

  it("accepts signal-custom target prefixes", () => {
    expect(normalizeSignalCustomMessagingTarget("signal-custom:+15550001111")).toBe("+15550001111");
    expect(normalizeSignalCustomMessagingTarget("signal-custom:group:grp-1")).toBe("group:grp-1");
    expect(looksLikeSignalCustomTargetId("signal-custom:+15550001111")).toBe(true);
  });

  it("merges top-level and account-scoped group config with account overrides", () => {
    const account = resolveSignalAccount({
      cfg: {
        channels: {
          "signal-custom": {
            groups: {
              "*": {
                requireMention: true,
                allowFrom: ["+15550001111"],
              },
              grp1: {
                allowFrom: ["+15550002222"],
                tools: { allow: ["message"] },
              },
            },
            accounts: {
              Work: {
                groups: {
                  "*": {
                    requireMention: false,
                  },
                  grp1: {
                    enabled: false,
                  },
                },
              },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    expect(account.config.groups).toEqual({
      "*": {
        requireMention: false,
        allowFrom: ["+15550001111"],
      },
      grp1: {
        allowFrom: ["+15550002222"],
        tools: { allow: ["message"] },
        enabled: false,
      },
    });
  });

  it("formats UUID allowlist entries without mangling them into phone numbers", () => {
    const cfg = {} as never;

    expect(
      signalCustomConfigAdapter.formatAllowFrom?.({
        cfg,
        accountId: "default",
        allowFrom: [
          "*",
          "signal:+1 (555) 123-4567",
          "uuid:123E4567-E89B-12D3-A456-426614174000",
          "123e4567-e89b-12d3-a456-426614174000",
          "garbage",
        ],
      }),
    ).toEqual([
      "*",
      "+15551234567",
      "uuid:123e4567-e89b-12d3-a456-426614174000",
      "uuid:123e4567-e89b-12d3-a456-426614174000",
    ]);
  });

  it("rejects invalid UUID allowlist entries during config normalization", () => {
    expect(
      signalCustomConfigAdapter.formatAllowFrom?.({
        cfg: {} as never,
        accountId: "default",
        allowFrom: ["uuid:not-a-uuid", "not-a-uuid", "+15550001111"],
      }),
    ).toEqual(["+15550001111"]);
  });

  it("normalizes security allowlist entries as UUIDs or E.164 values", () => {
    const resolved = signalCustomSecurityAdapter.resolveDmPolicy?.({
      cfg: {
        channels: {
          "signal-custom": {
            account: "+15550001111",
          },
        },
      } as never,
      accountId: "default",
      account: resolveSignalAccount({
        cfg: {
          channels: {
            "signal-custom": {
              account: "+15550001111",
            },
          },
        } as never,
        accountId: "default",
      }),
    });
    expect(resolved?.normalizeEntry).toBeTypeOf("function");
    const normalizeEntry = resolved!.normalizeEntry!;

    expect(normalizeEntry("signal:+1 (555) 123-4567")).toBe("+15551234567");
    expect(
      normalizeEntry("uuid:123E4567-E89B-12D3-A456-426614174000"),
    ).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
    expect(normalizeEntry("123e4567-e89b-12d3-a456-426614174000")).toBe(
      "uuid:123e4567-e89b-12d3-a456-426614174000",
    );
    expect(normalizeEntry("uuid:not-a-uuid")).toBe("");
    expect(normalizeEntry("not-a-uuid")).toBe("");
  });
});
