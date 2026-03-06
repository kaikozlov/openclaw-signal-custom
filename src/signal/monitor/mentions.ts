import type { SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

export type SignalMentionRenderResult = {
  text: string;
  // Map original mention end offsets to the expansion length delta.
  offsetShifts: Map<number, number>;
};

export function renderSignalMentions(
  message: string,
  mentions?: SignalMention[] | null,
): SignalMentionRenderResult {
  if (!message || !mentions?.length) {
    return { text: message, offsetShifts: new Map() };
  }

  let normalized = message;
  const offsetShifts = new Map<number, number>();
  const candidates = mentions
    .filter(isValidMention)
    .slice()
    .sort((a: SignalMention, b: SignalMention) => (b.start ?? 0) - (a.start ?? 0));

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    const replacement = `@${identifier}`;
    const shift = replacement.length - (end - start);
    normalized = normalized.slice(0, start) + replacement + normalized.slice(end);
    if (shift !== 0) {
      offsetShifts.set(end, (offsetShifts.get(end) ?? 0) + shift);
    }
  }

  return { text: normalized, offsetShifts };
}
