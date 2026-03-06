import {
  resolveAckReaction,
  shouldAckReaction,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { resolveSignalAccount } from "../../config.js";
import { SIGNAL_CHANNEL_ID } from "../../constants.js";
import { sendReactionSignal } from "../send-reactions.js";
import type { SignalSender } from "../identity.js";

function isAckReactionEnabled(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  const reactionLevel =
    resolveSignalAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    }).config.reactionLevel ?? "minimal";
  return reactionLevel === "ack";
}

export function maybeSendSignalAckReaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sender: SignalSender;
  targetTimestamp: number;
  isGroup: boolean;
  groupId?: string;
  wasMentioned?: boolean;
  canDetectMention?: boolean;
  requireMention?: boolean;
  accountId: string;
  onError?: (err: unknown) => void;
}): void {
  if (!isAckReactionEnabled({ cfg: params.cfg, accountId: params.accountId })) {
    return;
  }

  const emoji = resolveAckReaction(params.cfg, params.agentId, {
    channel: SIGNAL_CHANNEL_ID,
    accountId: params.accountId,
  }).trim();
  if (!emoji) {
    return;
  }
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    return;
  }

  const canDetectMention = params.canDetectMention ?? false;
  const requireMention = params.requireMention ?? false;
  const shouldSend = shouldAckReaction({
    scope: params.cfg.messages?.ackReactionScope,
    isDirect: !params.isGroup,
    isGroup: params.isGroup,
    isMentionableGroup: params.isGroup && canDetectMention,
    requireMention,
    canDetectMention,
    effectiveWasMentioned: params.wasMentioned ?? false,
    shouldBypassMention: !requireMention,
  });
  if (!shouldSend) {
    return;
  }

  const targetAuthor =
    params.sender.kind === "phone" ? params.sender.e164 : undefined;
  const targetAuthorUuid =
    params.sender.kind === "phone" ? params.sender.uuid : params.sender.raw;
  const recipient = params.sender.kind === "phone" ? params.sender.e164 : params.sender.raw;

  void sendReactionSignal(recipient, params.targetTimestamp, emoji, {
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.groupId,
    targetAuthor,
    targetAuthorUuid,
  }).catch((err) => params.onError?.(err));
}
