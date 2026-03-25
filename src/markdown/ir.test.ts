import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, markdownToIR } from "./ir.js";

describe("markdown IR", () => {
  it("collapses prose softbreaks while preserving paragraph breaks", () => {
    const ir = markdownToIR("first line\nsecond line\n\nthird line", {
      tableMode: "off",
    });

    expect(ir.text).toBe("first line second line\n\nthird line");
  });

  it("keeps style spans aligned when chunking formatted text", () => {
    const ir = markdownToIR("**alpha beta gamma**", {
      tableMode: "off",
    });
    const chunks = chunkMarkdownIR(ir, 10);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe("alpha beta gamma");
    expect(chunks).toEqual([
      {
        text: chunks[0]!.text,
        styles: [{ start: 0, end: chunks[0]!.text.length, style: "bold" }],
        links: [],
      },
      {
        text: chunks[1]!.text,
        styles: [{ start: 0, end: chunks[1]!.text.length, style: "bold" }],
        links: [],
      },
    ]);
  });
});
