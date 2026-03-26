import type { MarkdownTableMode } from "../runtime-api.js";
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownStyle,
} from "../markdown/ir.js";

type SignalTextStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";

export type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};

export type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};

export type SignalRenderedMentionRange = {
  start: number;
  length: number;
  recipient: string;
};

export type SignalFormattedChunk = SignalFormattedText & {
  mentions?: SignalRenderedMentionRange[];
};

type SignalMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

type SignalStyleSpan = {
  start: number;
  end: number;
  style: SignalTextStyle;
};

type Insertion = {
  pos: number;
  length: number;
};

type SourceMentionRange = {
  start: number;
  length: number;
  recipient: string;
};

type MentionMarker = {
  id: number;
  open: string;
  close: string;
  recipient: string;
};

const PRIVATE_USE_MARKER_START = 0xe000;
const PRIVATE_USE_MARKER_END = 0xf8ff;

function normalizeUrlForComparison(url: string): string {
  let normalized = url.replace(/[\uE000-\uF8FF]/g, "").toLowerCase();
  // Strip protocol
  normalized = normalized.replace(/^https?:\/\//, "");
  // Strip www. prefix
  normalized = normalized.replace(/^www\./, "");
  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function mapStyle(style: MarkdownStyle): SignalTextStyle | null {
  switch (style) {
    case "bold":
      return "BOLD";
    case "italic":
      return "ITALIC";
    case "strikethrough":
      return "STRIKETHROUGH";
    case "code":
    case "code_block":
      return "MONOSPACE";
    case "spoiler":
      return "SPOILER";
    default:
      return null;
  }
}

function mergeStyles(styles: SignalTextStyleRange[]): SignalTextStyleRange[] {
  const sorted = [...styles].sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a.style.localeCompare(b.style);
  });

  const merged: SignalTextStyleRange[] = [];
  for (const style of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === style.style && style.start <= prev.start + prev.length) {
      const prevEnd = prev.start + prev.length;
      const nextEnd = Math.max(prevEnd, style.start + style.length);
      prev.length = nextEnd - prev.start;
      continue;
    }
    merged.push({ ...style });
  }

  return merged;
}

function clampStyles(styles: SignalTextStyleRange[], maxLength: number): SignalTextStyleRange[] {
  const clamped: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const start = Math.max(0, Math.min(style.start, maxLength));
    const end = Math.min(style.start + style.length, maxLength);
    const length = end - start;
    if (length > 0) {
      clamped.push({ start, length, style: style.style });
    }
  }
  return clamped;
}

function sliceMentionRanges(
  mentions: SignalRenderedMentionRange[],
  start: number,
  end: number,
): SignalRenderedMentionRange[] {
  const sliced: SignalRenderedMentionRange[] = [];
  for (const mention of mentions) {
    const mentionEnd = mention.start + mention.length;
    const sliceStart = Math.max(mention.start, start);
    const sliceEnd = Math.min(mentionEnd, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        length: sliceEnd - sliceStart,
        recipient: mention.recipient,
      });
    }
  }
  return sliced;
}

function applyInsertionsToStyles(
  spans: SignalStyleSpan[],
  insertions: Insertion[],
): SignalStyleSpan[] {
  if (insertions.length === 0) {
    return spans;
  }
  const sortedInsertions = [...insertions].sort((a, b) => a.pos - b.pos);
  let updated = spans;
  let cumulativeShift = 0;

  for (const insertion of sortedInsertions) {
    const insertionPos = insertion.pos + cumulativeShift;
    const next: SignalStyleSpan[] = [];
    for (const span of updated) {
      if (span.end <= insertionPos) {
        next.push(span);
        continue;
      }
      if (span.start >= insertionPos) {
        next.push({
          start: span.start + insertion.length,
          end: span.end + insertion.length,
          style: span.style,
        });
        continue;
      }
      if (span.start < insertionPos && span.end > insertionPos) {
        if (insertionPos > span.start) {
          next.push({
            start: span.start,
            end: insertionPos,
            style: span.style,
          });
        }
        const shiftedStart = insertionPos + insertion.length;
        const shiftedEnd = span.end + insertion.length;
        if (shiftedEnd > shiftedStart) {
          next.push({
            start: shiftedStart,
            end: shiftedEnd,
            style: span.style,
          });
        }
      }
    }
    updated = next;
    cumulativeShift += insertion.length;
  }

  return updated;
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const text = ir.text ?? "";
  if (!text) {
    return { text: "", styles: [] };
  }

  const sortedLinks = [...ir.links].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const insertions: Insertion[] = [];

  for (const link of sortedLinks) {
    if (link.start < cursor) {
      continue;
    }
    out += text.slice(cursor, link.end);

    const href = link.href.trim();
    const label = text.slice(link.start, link.end);
    const trimmedLabel = label.trim();

    if (href) {
      if (!trimmedLabel) {
        out += href;
        insertions.push({ pos: link.end, length: href.length });
      } else {
        // Check if label is similar enough to URL that showing both would be redundant
        const normalizedLabel = normalizeUrlForComparison(trimmedLabel);
        let comparableHref = href;
        if (href.startsWith("mailto:")) {
          comparableHref = href.slice("mailto:".length);
        }
        const normalizedHref = normalizeUrlForComparison(comparableHref);

        // Only show URL if label is meaningfully different from it
        if (normalizedLabel !== normalizedHref) {
          const addition = ` (${href})`;
          out += addition;
          insertions.push({ pos: link.end, length: addition.length });
        }
      }
    }

    cursor = link.end;
  }

  out += text.slice(cursor);

  const mappedStyles: SignalStyleSpan[] = ir.styles
    .map((span) => {
      const mapped = mapStyle(span.style);
      if (!mapped) {
        return null;
      }
      return { start: span.start, end: span.end, style: mapped };
    })
    .filter((span): span is SignalStyleSpan => span !== null);

  const adjusted = applyInsertionsToStyles(mappedStyles, insertions);
  const trimmedText = out.trimEnd();
  const trimmedLength = trimmedText.length;
  const clamped = clampStyles(
    adjusted.map((span) => ({
      start: span.start,
      length: span.end - span.start,
      style: span.style,
    })),
    trimmedLength,
  );

  return {
    text: trimmedText,
    styles: mergeStyles(clamped),
  };
}

function containsExplicitMarkdownSyntax(markdown: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-+*]\s|\d+\.\s|\|)/.test(markdown) ||
    /```|`|\*\*|__|~~|\|\||\[[^\]]+\]\([^)]+\)/.test(markdown)
  );
}

function looksLikeStructuredPlainText(markdown: string): boolean {
  if (!markdown.includes("\n")) {
    return false;
  }
  if (containsExplicitMarkdownSyntax(markdown)) {
    return false;
  }

  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 3) {
    return false;
  }

  let structuredLines = 0;
  for (const line of lines) {
    if (
      /^[\p{Extended_Pictographic}\u200D\uFE0F]/u.test(line) ||
      /^[A-Za-z][^.!?]{0,24}:\s/.test(line) ||
      /^\/[a-z0-9_-]+/i.test(line) ||
      line.includes(" · ")
    ) {
      structuredLines += 1;
    }
  }

  return structuredLines / lines.length >= 0.6;
}

function preserveStructuredPlainText(markdown: string, limit: number): SignalFormattedText[] | null {
  if (!looksLikeStructuredPlainText(markdown)) {
    return null;
  }

  const text = markdown.trimEnd();
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [{ text, styles: [] }];
  }
  return splitSignalFormattedText({ text, styles: [] }, limit);
}

function injectMentionMarkers(
  markdown: string,
  mentions: SourceMentionRange[],
): { markedMarkdown: string; markers: MentionMarker[] } {
  if (mentions.length === 0) {
    return { markedMarkdown: markdown, markers: [] };
  }
  const sorted = [...mentions]
    .map((mention, index) => ({ ...mention, id: index }))
    .sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const mention of sorted) {
    if (!Number.isFinite(mention.start) || mention.start < 0) {
      throw new Error(`Signal mention ${mention.id} has an invalid start`);
    }
    if (!Number.isFinite(mention.length) || mention.length <= 0) {
      throw new Error(`Signal mention ${mention.id} has an invalid length`);
    }
    const end = mention.start + mention.length;
    if (end > markdown.length) {
      throw new Error(`Signal mention ${mention.id} exceeds message length`);
    }
    if (mention.start < previousEnd) {
      throw new Error(`Signal mention ${mention.id} overlaps another mention`);
    }
    previousEnd = end;
  }
  const markers = sorted.map((mention, index) => {
    const openCodePoint = PRIVATE_USE_MARKER_START + index * 2;
    const closeCodePoint = openCodePoint + 1;
    if (closeCodePoint > PRIVATE_USE_MARKER_END) {
      throw new Error("Too many Signal mentions to encode safely");
    }
    return {
      id: mention.id,
      open: String.fromCharCode(openCodePoint),
      close: String.fromCharCode(closeCodePoint),
      recipient: mention.recipient,
      start: mention.start,
      end: mention.start + mention.length,
    };
  });

  let markedMarkdown = markdown;
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const marker = markers[i] as MentionMarker & { start: number; end: number };
    markedMarkdown =
      markedMarkdown.slice(0, marker.end) +
      marker.close +
      markedMarkdown.slice(marker.end);
    markedMarkdown =
      markedMarkdown.slice(0, marker.start) +
      marker.open +
      markedMarkdown.slice(marker.start);
  }

  return {
    markedMarkdown,
    markers: markers.map(({ start: _start, end: _end, ...marker }) => marker),
  };
}

function stripMentionMarkers(params: {
  formatted: SignalFormattedText;
  markers: MentionMarker[];
}): SignalFormattedChunk {
  if (params.markers.length === 0) {
    return { ...params.formatted };
  }
  const eventMap = new Map<string, { id: number; kind: "open" | "close"; recipient: string }>();
  for (const marker of params.markers) {
    eventMap.set(marker.open, { id: marker.id, kind: "open", recipient: marker.recipient });
    eventMap.set(marker.close, { id: marker.id, kind: "close", recipient: marker.recipient });
  }

  const positionMap = new Array<number>(params.formatted.text.length + 1).fill(0);
  const mentionStarts = new Map<number, { start: number; recipient: string }>();
  const mentions: SignalRenderedMentionRange[] = [];
  let out = "";
  let outLength = 0;

  for (let i = 0; i < params.formatted.text.length; i += 1) {
    positionMap[i] = outLength;
    const char = params.formatted.text[i] ?? "";
    const event = eventMap.get(char);
    if (event) {
      if (event.kind === "open") {
        mentionStarts.set(event.id, { start: outLength, recipient: event.recipient });
      } else {
        const start = mentionStarts.get(event.id);
        if (!start) {
          throw new Error("Signal mention marker close encountered without open marker");
        }
        const length = outLength - start.start;
        if (length > 0) {
          mentions.push({ start: start.start, length, recipient: start.recipient });
        }
        mentionStarts.delete(event.id);
      }
      continue;
    }
    out += char;
    outLength += char.length;
  }
  positionMap[params.formatted.text.length] = outLength;

  if (mentionStarts.size > 0) {
    throw new Error("Signal mention marker open encountered without close marker");
  }

  const styles = clampStyles(
    params.formatted.styles.map((style) => ({
      start: positionMap[style.start] ?? 0,
      length: Math.max(0, (positionMap[style.start + style.length] ?? outLength) - (positionMap[style.start] ?? 0)),
      style: style.style,
    })),
    out.length,
  );

  return {
    text: out,
    styles: mergeStyles(styles),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

export function markdownToSignalText(
  markdown: string,
  options: SignalMarkdownOptions = {},
): SignalFormattedText {
  const preserved = preserveStructuredPlainText(markdown ?? "", Number.POSITIVE_INFINITY);
  if (preserved) {
    return preserved[0] ?? { text: "", styles: [] };
  }
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderSignalText(ir);
}

function sliceSignalStyles(
  styles: SignalTextStyleRange[],
  start: number,
  end: number,
): SignalTextStyleRange[] {
  const sliced: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const styleEnd = style.start + style.length;
    const sliceStart = Math.max(style.start, start);
    const sliceEnd = Math.min(styleEnd, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        length: sliceEnd - sliceStart,
        style: style.style,
      });
    }
  }
  return sliced;
}

/**
 * Split Signal formatted text into chunks under the limit while preserving styles.
 *
 * This implementation deterministically tracks cursor position without using indexOf,
 * which is fragile when chunks are trimmed or when duplicate substrings exist.
 * Styles spanning chunk boundaries are split into separate ranges for each chunk.
 */
function splitSignalFormattedText(
  formatted: SignalFormattedChunk,
  limit: number,
): SignalFormattedChunk[] {
  const { text, styles, mentions = [] } = formatted;

  if (text.length <= limit) {
    return [formatted];
  }

  const results: SignalFormattedChunk[] = [];
  let remaining = text;
  let offset = 0; // Track position in original text for style slicing

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      // Last chunk - take everything remaining
      const trimmed = remaining.trimEnd();
      if (trimmed.length > 0) {
        results.push({
          text: trimmed,
          styles: mergeStyles(sliceSignalStyles(styles, offset, offset + trimmed.length)),
          ...(sliceMentionRanges(mentions, offset, offset + trimmed.length).length > 0
            ? { mentions: sliceMentionRanges(mentions, offset, offset + trimmed.length) }
            : {}),
        });
      }
      break;
    }

    // Find a good break point within the limit
    const window = remaining.slice(0, limit);
    let breakIdx = findBreakIndex(window);

    // If no good break point found, hard break at limit
    if (breakIdx <= 0) {
      breakIdx = limit;
    }

    // Extract chunk and trim trailing whitespace
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();

    if (chunk.length > 0) {
      const chunkMentions = sliceMentionRanges(mentions, offset, offset + chunk.length);
      results.push({
        text: chunk,
        styles: mergeStyles(sliceSignalStyles(styles, offset, offset + chunk.length)),
        ...(chunkMentions.length > 0 ? { mentions: chunkMentions } : {}),
      });
    }

    // Advance past the chunk and any whitespace separator
    const brokeOnWhitespace = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnWhitespace ? 1 : 0));

    // Chunks are sent as separate messages, so we intentionally drop boundary whitespace.
    // Keep `offset` in sync with the dropped characters so style slicing stays correct.
    remaining = remaining.slice(nextStart).trimStart();
    offset = text.length - remaining.length;
  }

  return results;
}

/**
 * Find the best break index within a text window.
 * Prefers newlines over whitespace, avoids breaking inside parentheses.
 */
function findBreakIndex(window: string): number {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let parenDepth = 0;

  for (let i = 0; i < window.length; i++) {
    const char = window[i];

    if (char === "(") {
      parenDepth++;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth--;
      continue;
    }

    // Only consider break points outside parentheses
    if (parenDepth === 0) {
      if (char === "\n") {
        lastNewline = i;
      } else if (/\s/.test(char)) {
        lastWhitespace = i;
      }
    }
  }

  // Prefer newline break, fall back to whitespace
  return lastNewline > 0 ? lastNewline : lastWhitespace;
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions = {},
): SignalFormattedText[] {
  const preserved = preserveStructuredPlainText(markdown ?? "", limit);
  if (preserved) {
    return preserved;
  }
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  const results: SignalFormattedText[] = [];

  for (const chunk of chunks) {
    const rendered = renderSignalText(chunk);
    // If link expansion caused the chunk to exceed the limit, re-chunk it
    if (rendered.text.length > limit) {
      results.push(...splitSignalFormattedText(rendered, limit));
    } else {
      results.push(rendered);
    }
  }

  return results;
}

export function markdownToSignalRichChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions & { mentions?: SourceMentionRange[] } = {},
): SignalFormattedChunk[] {
  const mentions = options.mentions ?? [];
  if (mentions.length === 0) {
    return markdownToSignalTextChunks(markdown, limit, options);
  }

  const { markedMarkdown, markers } = injectMentionMarkers(markdown ?? "", mentions);
  const rendered = markdownToSignalText(markedMarkdown, options);
  const stripped = stripMentionMarkers({ formatted: rendered, markers });
  if (limit <= 0 || stripped.text.length <= limit) {
    return [stripped];
  }
  return splitSignalFormattedText(stripped, limit);
}
