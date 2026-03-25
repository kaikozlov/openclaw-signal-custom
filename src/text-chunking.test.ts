import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, type MarkdownIR } from "./markdown/ir.js";
import { chunkTextForOutbound } from "./text-chunking.js";

describe("chunkTextForOutbound", () => {
  it("prefers newline boundaries before falling back to word breaks", () => {
    expect(chunkTextForOutbound("alpha beta\ngamma delta", 12)).toEqual([
      "alpha beta",
      "gamma delta",
    ]);
  });

  it("falls back to hard limits when no whitespace is available", () => {
    expect(chunkTextForOutbound("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("chunkMarkdownIR", () => {
  it("returns the original ir when the limit does not require chunking", () => {
    const ir: MarkdownIR = {
      text: "short text",
      styles: [{ start: 0, end: 5, style: "bold" }],
      links: [],
    };

    expect(chunkMarkdownIR(ir, 100)).toEqual([ir]);
  });

  it("preserves style and link offsets across trimmed chunk boundaries", () => {
    const ir: MarkdownIR = {
      text: "alpha beta gamma",
      styles: [{ start: 6, end: 10, style: "bold" }],
      links: [{ start: 11, end: 16, href: "https://example.com" }],
    };

    const chunks = chunkMarkdownIR(ir, 10);

    expect(chunks).toEqual([
      {
        text: "alpha beta",
        styles: [{ start: 6, end: 10, style: "bold" }],
        links: [],
      },
      {
        text: "gamma",
        styles: [],
        links: [{ start: 0, end: 5, href: "https://example.com" }],
      },
    ]);
  });
});
