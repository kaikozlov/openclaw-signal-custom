import type { RuntimeEnv } from "../runtime-api.js";
import {
  buildSignalReconnectLogLine,
  computeSignalBackoff,
  formatSignalError,
  normalizeSignalError,
  resolveSignalGatewaySupervisionPolicy,
  shouldRetrySignalOperation,
  type SignalGatewaySupervisionPolicyInput,
} from "./reconnect-policy.js";

export type SignalGatewayPhase =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "failed";

export type SignalReceiveTransport = "jsonrpc-poll" | "jsonrpc-socket" | "sse";

type SignalGatewayStatusSink = (patch: Record<string, unknown>) => void;

export type SignalGatewaySupervisor = {
  readonly phase: SignalGatewayPhase;
  markStarting: (transport?: SignalReceiveTransport | null) => void;
  markConnected: (transport: SignalReceiveTransport) => void;
  markDisconnect: (error?: unknown, transport?: SignalReceiveTransport | null) => void;
  waitBeforeRestart: (error: unknown, attempt: number) => Promise<boolean>;
  markStopping: () => Promise<void>;
  markStopped: () => void;
  markFailed: (error: unknown) => void;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createSignalGatewaySupervisor(params: {
  accountId: string;
  runtime: RuntimeEnv;
  setStatus?: SignalGatewayStatusSink;
  supervision?: SignalGatewaySupervisionPolicyInput;
  managedDaemon: boolean;
  connectionMode: string;
}) : SignalGatewaySupervisor {
  const policy = resolveSignalGatewaySupervisionPolicy(params.supervision);
  let phase: SignalGatewayPhase = "stopped";
  let restartCount = 0;

  const publish = (patch: Record<string, unknown>) => {
    params.setStatus?.({
      accountId: params.accountId,
      ...patch,
    });
  };

  const publishDisconnect = (error?: unknown, transport?: SignalReceiveTransport | null) => {
    const message = error ? formatSignalError(error) : undefined;
    publish({
      connected: false,
      restartPending: false,
      lastDisconnect: message ? { at: Date.now(), error: message } : { at: Date.now() },
      ...(message ? { lastError: message } : {}),
      ...(transport ? { receiveTransport: transport } : {}),
    });
  };

  return {
    get phase() {
      return phase;
    },
    markStarting: (transport) => {
      phase = restartCount > 0 ? "restarting" : "starting";
      publish({
        running: true,
        connected: false,
        restartPending: false,
        supervisorState: phase,
        healthState: "starting",
        lastStartAt: Date.now(),
        reconnectAttempts: restartCount,
        supervisionRestarts: restartCount,
        managedDaemon: params.managedDaemon,
        connectionMode: params.connectionMode,
        ...(transport ? { receiveTransport: transport } : {}),
      });
    },
    markConnected: (transport) => {
      phase = "running";
      publish({
        running: true,
        connected: true,
        restartPending: false,
        reconnectAttempts: 0,
        lastConnectedAt: Date.now(),
        lastError: null,
        healthState: "healthy",
        supervisorState: phase,
        supervisionRestarts: restartCount,
        receiveTransport: transport,
        managedDaemon: params.managedDaemon,
        connectionMode: params.connectionMode,
      });
    },
    markDisconnect: (error, transport) => {
      publishDisconnect(error, transport);
      publish({
        healthState: phase === "failed" ? "failed" : "degraded",
        supervisorState: phase,
      });
    },
    waitBeforeRestart: async (error, attempt) => {
      const normalized = normalizeSignalError(error);
      if (
        !shouldRetrySignalOperation({
          policy,
          attempt,
          error,
        })
      ) {
        return false;
      }
      restartCount = attempt;
      const delayMs = computeSignalBackoff(policy, attempt);
      phase = "restarting";
      publishDisconnect(normalized);
      publish({
        running: true,
        restartPending: true,
        reconnectAttempts: attempt,
        supervisionRestarts: restartCount,
        healthState: "degraded",
        supervisorState: phase,
      });
      params.runtime.log?.(
        buildSignalReconnectLogLine({
          scope: "Signal gateway supervisor",
          attempt,
          maxAttempts: policy.maxAttempts,
          delayMs,
          error: normalized,
        }),
      );
      await sleep(delayMs);
      return true;
    },
    markStopping: async () => {
      phase = "stopping";
      publish({
        running: true,
        connected: false,
        restartPending: false,
        healthState: "stopping",
        supervisorState: phase,
      });
      await sleep(policy.drainGraceMs);
    },
    markStopped: () => {
      phase = "stopped";
      publish({
        running: false,
        connected: false,
        restartPending: false,
        healthState: "stopped",
        supervisorState: phase,
        lastStopAt: Date.now(),
      });
    },
    markFailed: (error) => {
      phase = "failed";
      const message = formatSignalError(error);
      publishDisconnect(error);
      publish({
        running: false,
        connected: false,
        restartPending: false,
        healthState: "failed",
        supervisorState: phase,
        lastError: message,
        lastStopAt: Date.now(),
      });
    },
  };
}
