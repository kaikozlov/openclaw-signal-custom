export type SignalReconnectPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
};

export type SignalReconnectPolicyInput = Partial<SignalReconnectPolicy> | undefined;

export type SignalGatewaySupervisionPolicy = SignalReconnectPolicy & {
  drainGraceMs: number;
};

export type SignalGatewaySupervisionPolicyInput =
  | (Partial<SignalGatewaySupervisionPolicy> & { drainGraceMs?: number })
  | undefined;

export const DEFAULT_SIGNAL_RECONNECT_POLICY: SignalReconnectPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 6,
};

export const DEFAULT_SIGNAL_GATEWAY_SUPERVISION_POLICY: SignalGatewaySupervisionPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 8,
  drainGraceMs: 2_500,
};

export class SignalReconnectExhaustedError extends Error {
  readonly scope: string;
  readonly attempt: number;
  readonly maxAttempts: number;

  constructor(params: {
    scope: string;
    attempt: number;
    maxAttempts: number;
    error?: Error;
  }) {
    const detail = params.error ? `: ${params.error.message}` : "";
    super(
      `${params.scope} reconnect exhausted after ${params.attempt}/${params.maxAttempts} attempts${detail}`,
    );
    this.name = "SignalReconnectExhaustedError";
    this.scope = params.scope;
    this.attempt = params.attempt;
    this.maxAttempts = params.maxAttempts;
    if (params.error) {
      this.cause = params.error;
    }
  }
}

function normalizeInt(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.trunc(value));
}

function resolveSignalReconnectPolicyBase<T extends SignalReconnectPolicy>(
  input: Partial<T> | undefined,
  defaults: T,
): T {
  const initialMs = normalizeInt(input?.initialMs, defaults.initialMs);
  const maxMs = Math.max(initialMs, normalizeInt(input?.maxMs, defaults.maxMs));
  const factor =
    typeof input?.factor === "number" && Number.isFinite(input.factor)
      ? Math.max(1, input.factor)
      : defaults.factor;
  const jitterRaw =
    typeof input?.jitter === "number" && Number.isFinite(input.jitter)
      ? input.jitter
      : defaults.jitter;
  const jitter = Math.max(0, Math.min(1, jitterRaw));
  const maxAttempts = normalizeInt(input?.maxAttempts, defaults.maxAttempts, 1);
  return {
    ...defaults,
    initialMs,
    maxMs,
    factor,
    jitter,
    maxAttempts,
  };
}

export function resolveSignalReconnectPolicy(
  input?: SignalReconnectPolicyInput,
): SignalReconnectPolicy {
  return resolveSignalReconnectPolicyBase(input, DEFAULT_SIGNAL_RECONNECT_POLICY);
}

export function resolveSignalGatewaySupervisionPolicy(
  input?: SignalGatewaySupervisionPolicyInput,
): SignalGatewaySupervisionPolicy {
  const policy = resolveSignalReconnectPolicyBase(
    input,
    DEFAULT_SIGNAL_GATEWAY_SUPERVISION_POLICY,
  );
  return {
    ...policy,
    drainGraceMs: normalizeInt(
      input?.drainGraceMs,
      DEFAULT_SIGNAL_GATEWAY_SUPERVISION_POLICY.drainGraceMs,
    ),
  };
}

export function computeSignalBackoff(
  policy: Pick<SignalReconnectPolicy, "initialMs" | "maxMs" | "factor" | "jitter">,
  attempt: number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const withoutJitter = Math.min(policy.maxMs, policy.initialMs * policy.factor ** exponent);
  if (policy.jitter <= 0) {
    return Math.trunc(withoutJitter);
  }
  const spread = withoutJitter * policy.jitter;
  const randomOffset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.trunc(withoutJitter + randomOffset));
}

export function normalizeSignalError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function formatSignalError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { code?: unknown }).code;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isAbortLikeSignalError(error: unknown): boolean {
  const message = formatSignalError(error).toLowerCase();
  return message.includes("aborted") || message.includes("signalsocketclient closed");
}

export function isNonRecoverableSignalError(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status === 400 || status === 401 || status === 403) {
    return true;
  }
  const code = readErrorCode(error);
  const message = formatSignalError(error).toLowerCase();
  if (code === -32601 || code === -32700) {
    return true;
  }
  return /invalid account|requires valid account parameter|unauthorized|forbidden|not linked|not registered|unknown method|method not found|invalid params|parse error/.test(
    message,
  );
}

export function shouldRetrySignalOperation(params: {
  policy: SignalReconnectPolicy;
  attempt: number;
  error: unknown;
}): boolean {
  if (isAbortLikeSignalError(params.error) || isNonRecoverableSignalError(params.error)) {
    return false;
  }
  return params.attempt < params.policy.maxAttempts;
}

export function buildSignalReconnectLogLine(params: {
  scope: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}) {
  const delaySeconds = (params.delayMs / 1000).toFixed(params.delayMs >= 1000 ? 1 : 3);
  return `${params.scope} failed (${formatSignalError(params.error)}); retrying in ${delaySeconds}s (attempt ${params.attempt}/${params.maxAttempts})`;
}

export async function sleepWithSignalAbort(
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
