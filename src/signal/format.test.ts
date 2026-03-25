import { describe, expect, it } from "vitest";
import {
  markdownToSignalRichChunks,
  markdownToSignalText,
  markdownToSignalTextChunks,
} from "./format.js";

describe("signal markdown formatting", () => {
  it("preserves nested emphasis as overlapping style ranges", () => {
    expect(markdownToSignalText("**bold _both_**", { tableMode: "off" })).toEqual({
      text: "bold both",
      styles: [
        { start: 0, length: 9, style: "BOLD" },
        { start: 5, length: 4, style: "ITALIC" },
      ],
    });
  });

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

  it("remaps native mention offsets when the mention is inside a markdown link label", () => {
    const [chunk] = markdownToSignalRichChunks("[@kai](https://example.com/u/kai)", 4000, {
      tableMode: "off",
      mentions: [{ start: 1, length: 4, recipient: "abc-123" }],
    });

    expect(chunk).toEqual({
      text: "@kai (https://example.com/u/kai)",
      styles: [],
      mentions: [{ start: 0, length: 4, recipient: "abc-123" }],
    });
  });

  it("renders spoilers, blockquotes, and inline code without spurious spacing", () => {
    expect(markdownToSignalText("> use `foo()` and ||hide||", { tableMode: "off" })).toEqual({
      text: "> use foo() and hide",
      styles: [
        { start: 6, length: 5, style: "MONOSPACE" },
        { start: 16, length: 4, style: "SPOILER" },
      ],
    });
  });

  it("keeps a single blank line between top-level lists and following paragraphs", () => {
    expect(markdownToSignalText("- a\n- b\n\nnext", { tableMode: "off" }).text).toBe(
      "• a\n• b\n\nnext",
    );
  });

  it("keeps mixed lists and paragraphs stable across nested boundaries", () => {
    expect(
      markdownToSignalText("before\n\n- one\n  - child\n- two\n\nafter", { tableMode: "off" }).text,
    ).toBe("before\n\n• one\n  • child\n• two\n\nafter");
  });

  it("keeps fenced code blocks separated without extra blank lines", () => {
    expect(markdownToSignalText("```js\nconst x = 1;\n```\nnext", { tableMode: "off" }).text).toBe(
      "const x = 1;\n\nnext",
    );
  });

  it("splits styled output across chunks while preserving style offsets", () => {
    const chunks = markdownToSignalTextChunks("**alpha beta gamma**", 10, { tableMode: "off" });

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe("alpha beta gamma");
    expect(chunks).toEqual([
      expect.objectContaining({
        styles: [{ start: 0, length: chunks[0]!.text.length, style: "BOLD" }],
      }),
      expect.objectContaining({
        styles: [{ start: 0, length: chunks[1]!.text.length, style: "BOLD" }],
      }),
    ]);
  });

  it("keeps link expansion stable near chunk boundaries", () => {
    const chunks = markdownToSignalTextChunks("See [site](https://example.com/very/long/path)", 20, {
      tableMode: "off",
    });

    expect(chunks[0]).toEqual({
      text: "See site",
      styles: [],
    });
    expect(chunks.slice(1).map((chunk) => chunk.text).join("")).toBe(
      "(https://example.com/very/long/path)",
    );
    expect(chunks.every((chunk) => chunk.styles.length === 0)).toBe(true);
  });
});
