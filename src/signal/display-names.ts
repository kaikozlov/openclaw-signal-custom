import { normalizeE164, type OpenClawConfig } from "../runtime-api.js";
import type { SignalSender } from "./identity.js";
import type { SignalMention } from "./monitor/event-handler.types.js";
import { listSignalContacts } from "./directory.js";

const DEFAULT_SIGNAL_DIRECTORY_REFRESH_TTL_MS = 5 * 60 * 1000;

type SignalDisplayNameIndex = {
  byNumber: Map<string, string>;
  byUuid: Map<string, string>;
};

function normalizeDisplayName(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normalizeUuid(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed || undefined;
}

export function buildSignalDisplayNameIndex(
  contacts: Array<{ name?: string | null; number?: string | null; uuid?: string | null }>,
): SignalDisplayNameIndex {
  const byNumber = new Map<string, string>();
  const byUuid = new Map<string, string>();

  for (const contact of contacts) {
    const name = normalizeDisplayName(contact.name);
    if (!name) {
      continue;
    }
    const number = normalizeDisplayName(contact.number);
    const uuid = normalizeUuid(contact.uuid);
    if (number) {
      byNumber.set(normalizeE164(number), name);
    }
    if (uuid) {
      byUuid.set(uuid, name);
    }
  }

  return { byNumber, byUuid };
}

function resolveMentionDisplayNameFromIndex(
  mention: SignalMention,
  index: SignalDisplayNameIndex,
): string | undefined {
  const explicitName = normalizeDisplayName(mention.name);
  if (explicitName) {
    return explicitName;
  }
  const number = normalizeDisplayName(mention.number);
  if (number) {
    const byNumber = index.byNumber.get(normalizeE164(number));
    if (byNumber) {
      return byNumber;
    }
  }
  const uuid = normalizeUuid(mention.uuid);
  if (uuid) {
    return index.byUuid.get(uuid);
  }
  return undefined;
}

function resolveSenderDisplayNameFromIndex(
  sender: SignalSender,
  index: SignalDisplayNameIndex,
): string | undefined {
  if (sender.kind === "phone") {
    return index.byNumber.get(sender.e164) ?? (sender.uuid ? index.byUuid.get(sender.uuid.toLowerCase()) : undefined);
  }
  return index.byUuid.get(sender.raw.toLowerCase());
}

export function createSignalDisplayNameResolver(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  refreshTtlMs?: number;
  now?: () => number;
  listContacts?: typeof listSignalContacts;
}) {
  let contactIndexPromise: Promise<SignalDisplayNameIndex> | null = null;
  let cachedIndex: SignalDisplayNameIndex | null = null;
  let cachedAt = 0;
  const refreshTtlMs = Math.max(0, params.refreshTtlMs ?? DEFAULT_SIGNAL_DIRECTORY_REFRESH_TTL_MS);
  const now = params.now ?? Date.now;
  const listContacts = params.listContacts ?? listSignalContacts;

  const loadContactIndex = async (): Promise<SignalDisplayNameIndex> => {
    const ageMs = now() - cachedAt;
    if (cachedIndex && ageMs >= 0 && ageMs < refreshTtlMs) {
      return cachedIndex;
    }
    if (!contactIndexPromise) {
      contactIndexPromise = listContacts({
        cfg: params.cfg,
        accountId: params.accountId,
      })
        .then((contacts) => {
          const next = buildSignalDisplayNameIndex(contacts);
          cachedIndex = next;
          cachedAt = now();
          return next;
        })
        .catch((err) => {
          if (cachedIndex) {
            return cachedIndex;
          }
          throw err;
        })
        .finally(() => {
          contactIndexPromise = null;
        });
    }
    return await contactIndexPromise;
  };

  return {
    resolveMentionDisplayName: async (mention: SignalMention): Promise<string | undefined> => {
      const explicitName = normalizeDisplayName(mention.name);
      if (explicitName) {
        return explicitName;
      }
      try {
        return resolveMentionDisplayNameFromIndex(mention, await loadContactIndex());
      } catch {
        return undefined;
      }
    },
    resolveSenderDisplayName: async (sender: SignalSender): Promise<string | undefined> => {
      try {
        return resolveSenderDisplayNameFromIndex(sender, await loadContactIndex());
      } catch {
        return undefined;
      }
    },
  };
}
