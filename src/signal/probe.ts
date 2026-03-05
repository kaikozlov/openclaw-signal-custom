import { signalCheck, signalRpcRequest } from "./client.js";

export type SignalProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  version?: string | null;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

export async function probeSignal(baseUrl: string, timeoutMs: number): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
  };

  const check = await signalCheck(baseUrl, timeoutMs);
  const restOk = check.ok;

  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
    });
    return {
      ...result,
      ok: true,
      status: restOk ? (check.status ?? 200) : null,
      version: parseSignalVersion(version),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (restOk) {
      return {
        ...result,
        ok: true,
        status: check.status ?? null,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      };
    }
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }
}
