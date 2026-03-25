export function chunkTextForOutbound(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    let breakAt = lastNewline > 0 ? lastNewline : lastSpace;
    if (breakAt <= 0) {
      breakAt = limit;
    }

    const chunk = remaining.slice(0, breakAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
