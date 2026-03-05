import {
  createScopedPairingAccess,
  issuePairingChallenge,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk";
import { SIGNAL_CHANNEL_ID } from "../../constants.js";
import { getSignalRuntime } from "../../runtime.js";
import { isSignalSenderAllowed, type SignalSender } from "../identity.js";

type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";

async function readSignalStoreAllowFrom(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
}): Promise<string[]> {
  if (params.dmPolicy === "allowlist") {
    return [];
  }
  const pairing = createScopedPairingAccess({
    core: getSignalRuntime(),
    channel: SIGNAL_CHANNEL_ID,
    accountId: params.accountId,
  });
  return await pairing.readAllowFromStore().catch(() => []);
}

export async function resolveSignalAccessState(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  sender: SignalSender;
}) {
  const storeAllowFrom = await readSignalStoreAllowFrom({
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
  });
  const resolveAccessDecision = (isGroup: boolean) =>
    resolveDmGroupAccessWithLists({
      isGroup,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: params.groupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowEntries) => isSignalSenderAllowed(params.sender, allowEntries),
    });
  const dmAccess = resolveAccessDecision(false);
  return {
    resolveAccessDecision,
    dmAccess,
    effectiveDmAllow: dmAccess.effectiveAllowFrom,
    effectiveGroupAllow: dmAccess.effectiveGroupAllowFrom,
  };
}

export async function handleSignalDirectMessageAccess(params: {
  dmPolicy: SignalDmPolicy;
  dmAccessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderIdLine: string;
  senderDisplay: string;
  senderName?: string;
  accountId: string;
  sendPairingReply: (text: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<boolean> {
  if (params.dmAccessDecision === "allow") {
    return true;
  }
  if (params.dmAccessDecision === "block") {
    if (params.dmPolicy !== "disabled") {
      params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
    }
    return false;
  }
  if (params.dmPolicy === "pairing") {
    const pairing = createScopedPairingAccess({
      core: getSignalRuntime(),
      channel: SIGNAL_CHANNEL_ID,
      accountId: params.accountId,
    });
    await issuePairingChallenge({
      channel: SIGNAL_CHANNEL_ID,
      senderId: params.senderId,
      senderIdLine: params.senderIdLine,
      meta: { name: params.senderName },
      upsertPairingRequest: async ({ id, meta }) =>
        await pairing.upsertPairingRequest({
          id,
          meta,
        }),
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.log(`signal pairing request sender=${params.senderId}`);
      },
      onReplyError: (err) => {
        params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
    });
  }
  return false;
}
