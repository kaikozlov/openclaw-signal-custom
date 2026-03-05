import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import { setSignalRuntime } from "./runtime.js";

describe("signalPlugin outbound sendMedia", () => {
  it("declares blockStreaming and mention strip patterns", () => {
    expect(signalPlugin.capabilities?.blockStreaming).toBe(true);
    expect(signalPlugin.mentions?.stripPatterns?.({} as never)).toEqual(["\uFFFC"]);
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

  it("resolves requireMention + tool policy from signal group config", () => {
    setSignalRuntime({
      channel: {
        groups: {
          resolveRequireMention: (params: { cfg: any; groupId?: string | null }) =>
            params.cfg.channels?.signal?.groups?.[params.groupId ?? ""]?.requireMention ?? true,
          resolveGroupPolicy: (params: { cfg: any; groupId?: string | null }) => ({
            allowlistEnabled: false,
            allowed: true,
            groupConfig: params.cfg.channels?.signal?.groups?.[params.groupId ?? ""],
          }),
        },
      },
    } as never);

    const cfg = {
      channels: {
        signal: {
          groups: {
            "signal:group:grp-1": {
              requireMention: false,
              tools: { allow: ["message"] },
              toolsBySender: {
                "id:user-123": { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as never;

    const requireMention = signalPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "signal:group:grp-1",
      accountId: "default",
    });
    const toolPolicy = signalPlugin.groups?.resolveToolPolicy?.({
      cfg,
      groupId: "signal:group:grp-1",
      accountId: "default",
      senderId: "user-123",
    });

    expect(requireMention).toBe(false);
    expect(toolPolicy).toEqual({ deny: ["exec"] });
  });

  it("requires targetAuthor for react actions before runtime handler call", async () => {
    const handleAction = vi.fn(async () => ({ content: [] }));
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
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: {},
      } as never),
    ).rejects.toThrow(/targetAuthor|targetAuthorUuid/);
    expect(handleAction).not.toHaveBeenCalled();

    await expect(
      signalPlugin.actions?.handleAction?.({
        channel: "signal",
        action: "react",
        cfg: {} as never,
        params: { targetAuthor: "+15550001111" },
      } as never),
    ).resolves.toEqual({ content: [] });
    expect(handleAction).toHaveBeenCalledTimes(1);
  });
});
