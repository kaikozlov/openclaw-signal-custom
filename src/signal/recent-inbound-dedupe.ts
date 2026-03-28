export type RecentSignalInboundDeduper = {
  recordAndCheckDuplicate: (key: string, nowMs?: number) => boolean;
  size: () => number;
};

export function createRecentSignalInboundDeduper(params?: {
  ttlMs?: number;
  maxEntries?: number;
}): RecentSignalInboundDeduper {
  const ttlMs = params?.ttlMs ?? 30_000;
  const maxEntries = params?.maxEntries ?? 1024;
  const seenAt = new Map<string, number>();

  const prune = (nowMs: number) => {
    for (const [key, recordedAt] of seenAt) {
      if (nowMs - recordedAt > ttlMs) {
        seenAt.delete(key);
      }
    }
    while (seenAt.size > maxEntries) {
      let oldest: string | undefined;
      let oldestRecordedAt = Number.POSITIVE_INFINITY;
      for (const [key, recordedAt] of seenAt) {
        if (recordedAt < oldestRecordedAt) {
          oldestRecordedAt = recordedAt;
          oldest = key;
        }
      }
      if (!oldest) {
        break;
      }
      seenAt.delete(oldest);
    }
  };

  return {
    recordAndCheckDuplicate: (key: string, nowMs = Date.now()) => {
      prune(nowMs);
      const existing = seenAt.get(key);
      if (typeof existing === "number" && nowMs - existing <= ttlMs) {
        seenAt.set(key, nowMs);
        return true;
      }
      seenAt.set(key, nowMs);
      prune(nowMs);
      return false;
    },
    size: () => seenAt.size,
  };
}
