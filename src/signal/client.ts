import { randomUUID } from "node:crypto";
import { SignalSocketClient } from "./socket-client.js";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  tcpHost?: string;
  tcpPort?: number;
  socketClient?: SignalSocketClient;
};

export type SignalRpcErrorPayload = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcErrorPayload;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_MIN_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
const DEFAULT_RETRY_JITTER = 0.2;
const socketClientRegistry = new Map<string, SignalSocketClient>();

export class SignalRpcError extends Error {
  readonly code: number | string;
  readonly data?: unknown;

  constructor(code: number | string, message: string, data?: unknown) {
    super(`Signal RPC ${code}: ${message}`);
    this.name = "SignalRpcError";
    this.code = code;
    this.data = data;
  }
}

export class SignalHttpError extends Error {
  readonly status: number;
  readonly statusText?: string;
  readonly body?: string;

  constructor(status: number, statusText?: string, body?: string) {
    super(`Signal RPC HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "SignalHttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class SignalNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SignalNetworkError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class SignalTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`Signal RPC timed out after ${timeoutMs}ms`);
    this.name = "SignalTimeoutError";
    this.timeoutMs = timeoutMs;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

type SignalRetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

export type SignalRetryAttemptInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: Error;
  method: string;
};

export type SignalRpcRetryOptions = SignalRpcOptions & {
  retry?: SignalRetryConfig;
  isRecoverable?: (error: Error) => boolean;
  onRetry?: (info: SignalRetryAttemptInfo) => void;
  abortSignal?: AbortSignal;
};

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function resolveSignalSocketRegistryKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function resolveSignalSocketClient(opts: SignalRpcOptions): SignalSocketClient | null {
  if (opts.socketClient) {
    return opts.socketClient;
  }
  const host = opts.tcpHost?.trim();
  const port = opts.tcpPort;
  if (!host || typeof port !== "number" || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  const key = resolveSignalSocketRegistryKey(host, Math.trunc(port));
  let client = socketClientRegistry.get(key);
  if (!client) {
    client = new SignalSocketClient({
      host,
      port: Math.trunc(port),
      reconnect: true,
    });
    socketClientRegistry.set(key, client);
  }
  client.connect();
  return client;
}

export function resetSignalSocketRegistryForTests() {
  for (const [, client] of socketClientRegistry) {
    client.close();
  }
  socketClientRegistry.clear();
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted due to timeout")
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function resolveSignalRetryConfig(retry?: SignalRetryConfig): Required<SignalRetryConfig> {
  const attempts = Math.max(
    1,
    Math.trunc(
      typeof retry?.attempts === "number" && Number.isFinite(retry.attempts)
        ? retry.attempts
        : DEFAULT_RETRY_ATTEMPTS,
    ),
  );
  const minDelayMs = Math.max(
    0,
    Math.trunc(
      typeof retry?.minDelayMs === "number" && Number.isFinite(retry.minDelayMs)
        ? retry.minDelayMs
        : DEFAULT_RETRY_MIN_DELAY_MS,
    ),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.trunc(
      typeof retry?.maxDelayMs === "number" && Number.isFinite(retry.maxDelayMs)
        ? retry.maxDelayMs
        : DEFAULT_RETRY_MAX_DELAY_MS,
    ),
  );
  const jitterRaw =
    typeof retry?.jitter === "number" && Number.isFinite(retry.jitter)
      ? retry.jitter
      : DEFAULT_RETRY_JITTER;
  const jitter = Math.min(1, Math.max(0, jitterRaw));
  return {
    attempts,
    minDelayMs,
    maxDelayMs,
    jitter,
  };
}

function computeBackoff(params: {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
}, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const withoutJitter = Math.min(
    params.maxMs,
    params.initialMs * params.factor ** exponent,
  );
  if (params.jitter <= 0) {
    return Math.trunc(withoutJitter);
  }
  const spread = withoutJitter * params.jitter;
  const randomOffset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.trunc(withoutJitter + randomOffset));
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
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

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await fetch(input, {
      ...init,
      signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function parseSignalRpcResponse<T>(text: string): SignalRpcResponse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SignalNetworkError("Signal RPC returned invalid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SignalNetworkError("Signal RPC returned invalid response envelope");
  }
  const envelope = parsed as SignalRpcResponse<T>;
  const hasResult = Object.hasOwn(envelope, "result");
  if (!envelope.error && !hasResult) {
    throw new SignalNetworkError("Signal RPC returned invalid response envelope");
  }
  return envelope;
}

export function isRecoverableSignalError(error: Error): boolean {
  if (error instanceof SignalTimeoutError || error instanceof SignalNetworkError) {
    return true;
  }
  if (error instanceof SignalHttpError) {
    return (
      error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    );
  }
  if (error instanceof SignalRpcError) {
    const message = error.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("timeout") ||
      message.includes("temporar") ||
      message.includes("unavailable")
    );
  }
  return false;
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketClient = resolveSignalSocketClient(opts);
  if (socketClient) {
    try {
      if (!socketClient.isConnected) {
        await socketClient.waitForConnect();
      }
      return await socketClient.request<T>(method, params, { timeoutMs });
    } catch (error) {
      if (!opts.baseUrl?.trim()) {
        if (isTimeoutLikeError(error)) {
          throw new SignalTimeoutError(timeoutMs, { cause: error });
        }
        throw new SignalNetworkError(`Signal socket request failed: ${String(error)}`, {
          cause: error,
        });
      }
    }
  }

  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${baseUrl}/api/v1/rpc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      timeoutMs,
    );
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      throw new SignalTimeoutError(timeoutMs, { cause: error });
    }
    throw new SignalNetworkError(`Signal RPC request failed: ${String(error)}`, { cause: error });
  }

  if (response.status === 201) {
    return undefined as T;
  }

  const text = await response.text();
  if (!response.ok) {
    throw new SignalHttpError(response.status, response.statusText || undefined, text || undefined);
  }
  if (!text) {
    return undefined as T;
  }

  const parsed = parseSignalRpcResponse<T>(text);
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const message = parsed.error.message ?? "Signal RPC error";
    throw new SignalRpcError(code, message, parsed.error.data);
  }
  return parsed.result as T;
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const response = await fetchWithTimeout(
      `${normalized}/api/v1/check`,
      { method: "GET" },
      timeoutMs,
    );
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, error: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });
  if (!res.ok || !res.body) {
    throw new SignalHttpError(res.status, res.statusText || undefined);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      const [rawField, ...rest] = line.split(":");
      const field = rawField.trim();
      const rawValue = rest.join(":");
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }
      lineEnd = buffer.indexOf("\n");
    }
  }

  flushEvent();
}

export async function signalRpcRequestWithRetry<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcRetryOptions,
): Promise<T> {
  const retryConfig = resolveSignalRetryConfig(opts.retry);
  const isRecoverable = opts.isRecoverable ?? isRecoverableSignalError;
  let attempt = 0;
  while (attempt < retryConfig.attempts) {
    attempt += 1;
    try {
      return await signalRpcRequest<T>(method, params, opts);
    } catch (error) {
      const normalized = normalizeError(error);
      const canRetry = attempt < retryConfig.attempts && isRecoverable(normalized);
      if (!canRetry) {
        throw normalized;
      }
      const delayMs = computeBackoff(
        {
          initialMs: retryConfig.minDelayMs,
          maxMs: retryConfig.maxDelayMs,
          factor: 2,
          jitter: retryConfig.jitter,
        },
        attempt,
      );
      opts.onRetry?.({
        attempt,
        maxAttempts: retryConfig.attempts,
        delayMs,
        error: normalized,
        method,
      });
      await sleepWithAbort(delayMs, opts.abortSignal);
    }
  }
  throw new Error("Signal RPC retry exhausted");
}
