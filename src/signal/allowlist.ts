import { normalizeE164 } from "../runtime-api.js";

const SIGNAL_ALLOWLIST_E164_RE = /^\+\d{5,15}$/;
const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSignalUuid(value: string): boolean {
  return SIGNAL_UUID_RE.test(value.trim());
}

export function normalizeSignalUuid(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !isSignalUuid(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

export function normalizeSignalAllowlistEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^signal(-custom)?:/i, "").trim();
  if (!withoutPrefix) {
    return "";
  }
  if (withoutPrefix === "*") {
    return "*";
  }
  if (withoutPrefix.toLowerCase().startsWith("uuid:")) {
    const uuid = normalizeSignalUuid(withoutPrefix.slice("uuid:".length));
    return uuid ? `uuid:${uuid}` : "";
  }
  const bareUuid = normalizeSignalUuid(withoutPrefix);
  if (bareUuid) {
    return `uuid:${bareUuid}`;
  }
  const normalized = normalizeE164(withoutPrefix);
  return SIGNAL_ALLOWLIST_E164_RE.test(normalized) ? normalized : "";
}
