import { describe, expect, it } from "vitest";
import { markdownToSignalRichChunks, markdownToSignalText } from "./format.js";

describe("signal markdown formatting", () => {
  it("remaps native mention offsets after markdown normalization", () => {
    const [chunk] = markdownToSignalRichChunks("**@kai** hello", 4000, {
      tableMode: "off",
      mentions: [{ start: 2, length: 4, recipient: "abc-123" }],
    });

    expect(chunk).toEqual({
      text: "@kai hello",
      styles: [{ start: 0, length: 4, style: "BOLD" }],
      mentions: [{ start: 0, length: 4, recipient: "abc-123" }],
    });
  });

  it("keeps a single blank line between top-level lists and following paragraphs", () => {
    expect(markdownToSignalText("- a\n- b\n\nnext", { tableMode: "off" }).text).toBe(
      "• a\n• b\n\nnext",
    );
  });

  it("keeps fenced code blocks separated without extra blank lines", () => {
    expect(markdownToSignalText("```js\nconst x = 1;\n```\nnext", { tableMode: "off" }).text).toBe(
      "const x = 1;\n\nnext",
    );
  });
});
