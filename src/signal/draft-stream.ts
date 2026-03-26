import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import type { OpenClawConfig } from "../runtime-api.js";
import { deleteMessageSignal, editMessageSignal } from "./send-actions.js";
import { sendMessageSignal, type SignalSendResult } from "./send.js";

const DEFAULT_THROTTLE_MS = 1200;
const DEFAULT_MIN_INITIAL_CHARS = 30;

export type SignalDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
  messageId: () => string | undefined;
  failed: () => boolean;
};

export function createSignalDraftStream(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string;
  replyToId?: string;
  maxChars?: number;
  throttleMs?: number;
  minInitialChars?: number;
  send?: typeof sendMessageSignal;
  edit?: typeof editMessageSignal;
  remove?: typeof deleteMessageSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): SignalDraftStream {
  const maxChars = Math.max(1, Math.trunc(params.maxChars ?? 4_000));
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = Math.max(1, params.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS);
  const send = params.send ?? sendMessageSignal;
  const edit = params.edit ?? editMessageSignal;
  const remove = params.remove ?? deleteMessageSignal;

  let streamMessageId: string | undefined;
  let lastSentText = "";
  let stopped = false;
  let failed = false;

  const sendOrEditStreamMessage = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(`signal stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    if (!streamMessageId && trimmed.length < minInitialChars) {
      return false;
    }
    lastSentText = trimmed;
    try {
      if (streamMessageId) {
        const edited = await edit({
          cfg: params.cfg,
          to: params.to,
          text: trimmed,
          textMode: "plain",
          editTimestamp: Number(streamMessageId),
          opts: { accountId: params.accountId },
        });
        streamMessageId = edited.messageId || streamMessageId;
        return true;
      }
      const sent: SignalSendResult = await send(params.to, trimmed, {
        cfg: params.cfg,
        accountId: params.accountId,
        replyTo: params.replyToId,
        textMode: "plain",
      });
      if (!sent.messageId?.trim()) {
        failed = true;
        stopped = true;
        params.warn?.("signal stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sent.messageId;
      return true;
    } catch (err) {
      failed = true;
      stopped = true;
      params.warn?.(`signal stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const stop = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
  };

  const clear = async () => {
    await stop();
    const messageId = streamMessageId;
    streamMessageId = undefined;
    lastSentText = "";
    if (!messageId) {
      return;
    }
    try {
      await remove({
        cfg: params.cfg,
        to: params.to,
        targetTimestamp: Number(messageId),
        opts: { accountId: params.accountId },
      });
    } catch (err) {
      params.warn?.(
        `signal stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`signal stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: loop.update,
    flush: loop.flush,
    clear,
    stop,
    forceNewMessage,
    messageId: () => streamMessageId,
    failed: () => failed,
  };
}
