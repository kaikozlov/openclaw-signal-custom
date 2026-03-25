import { describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";
import {
  inferSignalCustomTargetChatType,
  parseSignalCustomExplicitTarget,
  resolveSignalCustomOutboundSessionRoute,
} from "./targets.js";

describe("signal custom target parsing", () => {
  it("parses explicit direct targets across signal prefixes", () => {
    expect(
      parseSignalCustomExplicitTarget("signal:uuid:123E4567-E89B-12D3-A456-426614174000"),
    ).toEqual({
      to: "123e4567-e89b-12d3-a456-426614174000",
      chatType: "direct",
    });
    expect(parseSignalCustomExplicitTarget("signal-custom:+15551234567")).toEqual({
      to: "+15551234567",
      chatType: "direct",
    });
  });

  it("parses explicit group targets and preserves case-sensitive group ids", () => {
    expect(
      parseSignalCustomExplicitTarget(
        "signal-custom:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      ),
    ).toEqual({
      to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      chatType: "group",
    });
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferSignalCustomTargetChatType("group:grp-1")).toBe("group");
    expect(inferSignalCustomTargetChatType("username:kai")).toBe("direct");
    expect(inferSignalCustomTargetChatType("+15551234567")).toBe("direct");
    expect(inferSignalCustomTargetChatType("")).toBeUndefined();
  });
});

describe("signal custom outbound session routing", () => {
  it("builds per-channel-peer direct session routes", () => {
    expect(
      resolveSignalCustomOutboundSessionRoute({
        cfg: { session: { dmScope: "per-channel-peer" } },
        agentId: "main",
        target: "signal-custom:+15551234567",
      }),
    ).toEqual({
      sessionKey: "agent:main:signal-custom:direct:+15551234567",
      baseSessionKey: "agent:main:signal-custom:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      chatType: "direct",
      from: "signal-custom:+15551234567",
      to: "signal-custom:+15551234567",
    });
  });

  it("builds group session routes without collapsing them into main", () => {
    expect(
      resolveSignalCustomOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "signal:group:grp-1",
      }),
    ).toEqual({
      sessionKey: "agent:main:signal-custom:group:grp-1",
      baseSessionKey: "agent:main:signal-custom:group:grp-1",
      peer: { kind: "group", id: "grp-1" },
      chatType: "group",
      from: "signal-custom:group:grp-1",
      to: "signal-custom:group:grp-1",
    });
  });

  it("collapses direct routes to main when dm scope is left at default", () => {
    expect(
      resolveSignalCustomOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "signal:+15550001111",
      }),
    ).toEqual({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "direct", id: "+15550001111" },
      chatType: "direct",
      from: "signal-custom:+15550001111",
      to: "signal-custom:+15550001111",
    });
  });

  it("wires the messaging adapter through the plugin surface", () => {
    expect(
      signalPlugin.messaging?.parseExplicitTarget?.({
        raw: "signal-custom:group:grp-2",
      }),
    ).toEqual({
      to: "group:grp-2",
      chatType: "group",
    });
    expect(
      signalPlugin.messaging?.inferTargetChatType?.({
        to: "signal:+15551230000",
      }),
    ).toBe("direct");
    expect(
      signalPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: { session: { dmScope: "per-channel-peer" } },
        agentId: "main",
        target: "signal:+15551230000",
      }),
    ).toEqual({
      sessionKey: "agent:main:signal-custom:direct:+15551230000",
      baseSessionKey: "agent:main:signal-custom:direct:+15551230000",
      peer: { kind: "direct", id: "+15551230000" },
      chatType: "direct",
      from: "signal-custom:+15551230000",
      to: "signal-custom:+15551230000",
    });
  });
});
