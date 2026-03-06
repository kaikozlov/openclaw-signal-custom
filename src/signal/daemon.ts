import { spawn } from "node:child_process";
import { isSafeExecutableValue } from "../exec-safety.js";

type SignalDaemonRuntime = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type SignalDaemonOpts = {
  cliPath: string;
  configPath?: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  tcpHost?: string;
  tcpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: SignalDaemonRuntime;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
  exited: Promise<SignalDaemonExitEvent>;
  isExited: () => boolean;
};

export type SignalDaemonExitEvent = {
  source: "process" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function formatSignalDaemonExit(exit: SignalDaemonExitEvent): string {
  return `signal daemon exited (source=${exit.source} code=${String(exit.code ?? "null")} signal=${String(exit.signal ?? "null")})`;
}

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) {
    return "error";
  }
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return "error";
  }
  return "log";
}

function bindSignalCliOutput(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  log: (message: string) => void;
  error: (message: string) => void;
  quiet?: boolean;
}): void {
  params.stream?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        if (!params.quiet) {
          params.log(`signal-cli: ${line.trim()}`);
        }
      } else if (kind === "error") {
        params.error(`signal-cli: ${line.trim()}`);
      }
    }
  });
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.configPath?.trim()) {
    args.push("--config", opts.configPath.trim());
  }
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  if (opts.tcpHost && opts.tcpPort) {
    args.push("--tcp", `${opts.tcpHost}:${opts.tcpPort}`);
  } else {
    args.push("--no-receive-stdout");
  }
  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) {
    args.push("--ignore-attachments");
  }
  if (opts.ignoreStories) {
    args.push("--ignore-stories");
  }
  if (opts.sendReadReceipts) {
    args.push("--send-read-receipts");
  }
  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  if (!isSafeExecutableValue(opts.cliPath)) {
    throw new Error(`Invalid signal-cli path: ${opts.cliPath}`);
  }
  const args = buildDaemonArgs(opts);
  const child = spawn(opts.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});
  const quiet = Boolean(opts.tcpHost && opts.tcpPort);
  let exited = false;
  let settledExit = false;
  let resolveExit!: (value: SignalDaemonExitEvent) => void;
  const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
    resolveExit = resolve;
  });
  const settleExit = (value: SignalDaemonExitEvent) => {
    if (settledExit) {
      return;
    }
    settledExit = true;
    exited = true;
    resolveExit(value);
  };

  bindSignalCliOutput({ stream: child.stdout, log, error, quiet });
  bindSignalCliOutput({ stream: child.stderr, log, error, quiet });
  child.once("exit", (code, signal) => {
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
    error(
      formatSignalDaemonExit({ source: "process", code: code ?? null, signal: signal ?? null }),
    );
  });
  child.once("close", (code, signal) => {
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
    settleExit({ source: "spawn-error", code: null, signal: null });
  });

  return {
    pid: child.pid ?? undefined,
    exited: exitedPromise,
    isExited: () => exited,
    stop: () => {
      if (!child.killed && !exited) {
        child.kill("SIGTERM");
      }
    },
  };
}
