import { describe, expect, it, vi } from "vitest";
import { createSignalDraftStream } from "./draft-stream.js";

describe("signal draft stream", () => {
  const cfg = { channels: { "signal-custom": {} } } as never;

  it("waits for the minimum initial threshold before sending the first preview", async () => {
    const send = vi.fn(async () => ({ messageId: "1700000000001" }));
    const edit = vi.fn(async () => ({ messageId: "1700000000001" }));

    const stream = createSignalDraftStream({
      cfg,
      to: "+15550001111",
      minInitialChars: 5,
      send,
      edit,
    });

    stream.update("hey");
    await stream.flush();
    expect(send).not.toHaveBeenCalled();

    stream.update("hello");
    await stream.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
  });

  it("edits the same preview message for subsequent partials", async () => {
    const send = vi.fn(async () => ({ messageId: "1700000000001" }));
    const edit = vi.fn(async () => ({ messageId: "1700000000001" }));

    const stream = createSignalDraftStream({
      cfg,
      to: "+15550001111",
      minInitialChars: 1,
      send,
      edit,
    });

    stream.update("hello");
    await stream.flush();
    stream.update("hello there");
    await stream.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15550001111",
        text: "hello there",
        editTimestamp: 1700000000001,
      }),
    );
  });

  it("stops preview mode after a failed initial send", async () => {
    const send = vi.fn(async () => {
      throw new Error("send failed");
    });

    const stream = createSignalDraftStream({
      cfg,
      to: "+15550001111",
      minInitialChars: 1,
      send,
    });

    stream.update("hello");
    await stream.flush();
    stream.update("hello again");
    await stream.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(stream.failed()).toBe(true);
  });

  it("stops preview mode after a failed edit and can clear the preview message", async () => {
    const send = vi.fn(async () => ({ messageId: "1700000000001" }));
    const edit = vi.fn(async () => {
      throw new Error("edit failed");
    });
    const remove = vi.fn(async () => {});

    const stream = createSignalDraftStream({
      cfg,
      to: "+15550001111",
      minInitialChars: 1,
      send,
      edit,
      remove,
    });

    stream.update("hello");
    await stream.flush();
    stream.update("hello again");
    await stream.flush();
    stream.update("hello one more time");
    await stream.flush();

    expect(edit).toHaveBeenCalledOnce();
    expect(stream.failed()).toBe(true);

    await stream.clear();

    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15550001111",
        targetTimestamp: 1700000000001,
      }),
    );
  });
});
