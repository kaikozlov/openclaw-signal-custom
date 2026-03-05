import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => text,
  } as Response;
}

describe("signal reactions RPC", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  const cfg = {
    channels: {
      "signal-custom": {
        account: "+15550001111",
        httpUrl: "http://signal.local",
      },
    },
  } as never;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends direct reaction with normalized targetAuthor and recipients", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 123, results: [{ type: "SUCCESS" }] },
      }),
    );

    const result = await sendReactionSignal(
      "uuid:123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      {
        cfg,
        targetAuthor: "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
      },
    );

    expect(result).toEqual({ ok: true, timestamp: 123 });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("sendReaction");
    expect(body.params).toEqual(
      expect.objectContaining({
        recipients: ["123e4567-e89b-12d3-a456-426614174000"],
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
  });

  it("sends group reaction removal using groupIds", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: { timestamp: 456, results: [{ type: "SUCCESS" }] },
      }),
    );

    await removeReactionSignal("", 456, "❌", {
      cfg,
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual(
      expect.objectContaining({
        groupIds: ["group-id"],
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        remove: true,
      }),
    );
  });

  it("throws for per-recipient sendReaction failures", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        jsonrpc: "2.0",
        result: {
          timestamp: 789,
          results: [
            {
              type: "UNREGISTERED_FAILURE",
              recipientAddress: { number: "+15559999999" },
            },
          ],
        },
      }),
    );

    await expect(
      sendReactionSignal("+15559999999", 100, "👍", {
        cfg,
        targetAuthor: "+15559999999",
      }),
    ).rejects.toThrow(/Signal sendReaction failed for recipient result/);
  });
});
