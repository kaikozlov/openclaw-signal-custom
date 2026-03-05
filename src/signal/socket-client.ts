import { randomUUID } from "node:crypto";
import net from "node:net";

export type SignalSocketRequestOptions = {
  timeoutMs?: number;
};

export type SignalSocketEvent = {
  method: string;
  params: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type SignalSocketReconnectPolicy = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
};

export type SignalSocketClientOptions = {
  host: string;
  port: number;
  defaultTimeoutMs?: number;
  onEvent?: (event: SignalSocketEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (err?: Error) => void;
  reconnect?: boolean;
  reconnectPolicy?: SignalSocketReconnectPolicy;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_POLICY = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

function computeBackoff(policy: Required<SignalSocketReconnectPolicy>, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const withoutJitter = Math.min(policy.maxMs, policy.initialMs * policy.factor ** exponent);
  if (policy.jitter <= 0) {
    return Math.trunc(withoutJitter);
  }
  const spread = withoutJitter * policy.jitter;
  const randomOffset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.trunc(withoutJitter + randomOffset));
}

function resolveReconnectPolicy(
  policy?: SignalSocketReconnectPolicy,
): Required<SignalSocketReconnectPolicy> {
  return {
    initialMs:
      typeof policy?.initialMs === "number" && Number.isFinite(policy.initialMs)
        ? Math.max(0, Math.trunc(policy.initialMs))
        : DEFAULT_RECONNECT_POLICY.initialMs,
    maxMs:
      typeof policy?.maxMs === "number" && Number.isFinite(policy.maxMs)
        ? Math.max(0, Math.trunc(policy.maxMs))
        : DEFAULT_RECONNECT_POLICY.maxMs,
    factor:
      typeof policy?.factor === "number" && Number.isFinite(policy.factor)
        ? Math.max(1, policy.factor)
        : DEFAULT_RECONNECT_POLICY.factor,
    jitter:
      typeof policy?.jitter === "number" && Number.isFinite(policy.jitter)
        ? Math.max(0, Math.min(1, policy.jitter))
        : DEFAULT_RECONNECT_POLICY.jitter,
  };
}

export class SignalSocketClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = "";
  private connected = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectListeners: Array<() => void> = [];

  private readonly host: string;
  private readonly port: number;
  private readonly defaultTimeoutMs: number;
  onEvent?: (event: SignalSocketEvent) => void;
  private readonly onConnect?: () => void;
  private readonly onDisconnect?: (err?: Error) => void;
  private readonly shouldReconnect: boolean;
  private readonly reconnectPolicy: Required<SignalSocketReconnectPolicy>;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;

  constructor(opts: SignalSocketClientOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onEvent = opts.onEvent;
    this.onConnect = opts.onConnect;
    this.onDisconnect = opts.onDisconnect;
    this.shouldReconnect = opts.reconnect ?? true;
    this.reconnectPolicy = resolveReconnectPolicy(opts.reconnectPolicy);
    this.log = opts.log ?? (() => {});
    this.logError = opts.error ?? (() => {});
  }

  connect(): void {
    if (this.closed || this.connected || this.socket) {
      return;
    }
    this.doConnect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.destroySocket();
    this.flushPendingErrors(new Error("SignalSocketClient closed"));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: SignalSocketRequestOptions,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("SignalSocketClient is closed");
    }
    if (!this.connected || !this.socket) {
      throw new Error("SignalSocketClient is not connected");
    }

    const id = randomUUID();
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    });

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(new Error(`Signal socket RPC timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.socket?.write(`${envelope}\n`, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(new Error(`Signal socket write failed: ${err.message}`));
          }
        }
      });
    });
  }

  private doConnect(): void {
    if (this.closed) {
      return;
    }

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    this.buffer = "";

    socket.on("connect", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.log(`Signal socket connected to ${this.host}:${this.port}`);
      this.onConnect?.();
      const listeners = this.connectListeners;
      this.connectListeners = [];
      for (const fn of listeners) {
        fn();
      }
    });

    socket.on("data", (data) => {
      this.buffer += data.toString("utf8");
      this.processBuffer();
    });

    socket.on("error", (err) => {
      this.logError(`Signal socket error: ${err.message}`);
    });

    socket.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      const disconnectError = new Error("Signal socket connection lost");
      this.flushPendingErrors(disconnectError);

      if (wasConnected) {
        this.onDisconnect?.(disconnectError);
      }

      if (!this.closed && this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private processBuffer(): void {
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);

      if (line) {
        this.handleLine(line);
      }

      idx = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.logError(`Signal socket received invalid JSON: ${line.slice(0, 200)}`);
      return;
    }

    const id = parsed.id;
    if (typeof id === "string" && this.pending.has(id)) {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);

      if (parsed.error) {
        const err = parsed.error as { code?: number; message?: string };
        const code = err.code ?? "unknown";
        const msg = err.message ?? "Signal socket RPC error";
        entry.reject(new Error(`Signal RPC ${code}: ${msg}`));
      } else {
        entry.resolve(parsed.result);
      }
      return;
    }

    if ((id === null || id === undefined) && typeof parsed.method === "string") {
      this.onEvent?.({
        method: parsed.method,
        params: parsed.params,
      });
      return;
    }

    this.log(`Signal socket unmatched message: ${line.slice(0, 200)}`);
  }

  private flushPendingErrors(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private destroySocket(): void {
    if (this.socket) {
      this.connected = false;
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = computeBackoff(this.reconnectPolicy, this.reconnectAttempt);
    this.log(`Signal socket reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delayMs);
  }

  async waitForConnect(abortSignal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.closed) {
      throw new Error("SignalSocketClient is closed");
    }
    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        const idx = this.connectListeners.indexOf(onConnect);
        if (idx !== -1) {
          this.connectListeners.splice(idx, 1);
        }
        reject(new Error("aborted"));
      };
      this.connectListeners.push(onConnect);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
