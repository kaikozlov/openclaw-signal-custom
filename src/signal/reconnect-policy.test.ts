import { describe, expect, it } from "vitest";
import {
  buildSignalReconnectLogLine,
  computeSignalBackoff,
  resolveSignalGatewaySupervisionPolicy,
  resolveSignalReconnectPolicy,
  shouldRetrySignalOperation,
} from "./reconnect-policy.js";

describe("signal reconnect policy", () => {
  it("resolves sane reconnect defaults", () => {
    expect(resolveSignalReconnectPolicy()).toEqual({
      initialMs: 1000,
      maxMs: 10000,
      factor: 2,
      jitter: 0.2,
      maxAttempts: 6,
    });
  });

  it("clamps invalid reconnect inputs", () => {
    expect(
      resolveSignalReconnectPolicy({
        initialMs: -1,
        maxMs: 0,
        factor: 0,
        jitter: 9,
        maxAttempts: 0,
      }),
    ).toEqual({
      initialMs: 0,
      maxMs: 0,
      factor: 1,
      jitter: 1,
      maxAttempts: 1,
    });
  });

  it("resolves supervision defaults including drain grace", () => {
    expect(resolveSignalGatewaySupervisionPolicy()).toEqual({
      initialMs: 2000,
      maxMs: 30000,
      factor: 1.8,
      jitter: 0.25,
      maxAttempts: 8,
      drainGraceMs: 2500,
    });
  });

  it("computes deterministic backoff when jitter is disabled", () => {
    expect(
      computeSignalBackoff(
        {
          initialMs: 100,
          maxMs: 1_000,
          factor: 2,
          jitter: 0,
        },
        3,
      ),
    ).toBe(400);
  });

  it("stops retrying for non-recoverable or exhausted failures", () => {
    const policy = resolveSignalReconnectPolicy({ maxAttempts: 2, jitter: 0 });

    expect(
      shouldRetrySignalOperation({
        policy,
        attempt: 1,
        error: new Error("connection lost"),
      }),
    ).toBe(true);
    expect(
      shouldRetrySignalOperation({
        policy,
        attempt: 2,
        error: new Error("connection lost"),
      }),
    ).toBe(false);
    expect(
      shouldRetrySignalOperation({
        policy,
        attempt: 1,
        error: { status: 401, message: "unauthorized" },
      }),
    ).toBe(false);
  });

  it("formats reconnect log lines with scope, delay, and attempt counts", () => {
    expect(
      buildSignalReconnectLogLine({
        scope: "Signal SSE stream",
        attempt: 2,
        maxAttempts: 6,
        delayMs: 1500,
        error: new Error("connection reset"),
      }),
    ).toContain("Signal SSE stream failed (connection reset); retrying in 1.5s (attempt 2/6)");
  });
});
