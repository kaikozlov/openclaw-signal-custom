import type {
  DmPolicy,
  GroupPolicy,
  HistoryEntry,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { SignalReactionNotificationMode } from "../../config.js";
import type { SignalSender } from "../identity.js";

export type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  source?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: {
    targetSentTimestamp?: number | string | null;
    dataMessage?: SignalDataMessage | null;
  } | null;
  syncMessage?: unknown;
  reactionMessage?: SignalReactionMessage | null;
};

export type SignalMention = {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  start?: number | null;
  length?: number | null;
};

export type SignalDataMessage = {
  timestamp?: number | string | null;
  message?: string | null;
  attachments?: Array<SignalAttachment>;
  sticker?: SignalSticker | null;
  previews?: Array<SignalLinkPreview> | null;
  textStyles?: Array<SignalTextStyleRange> | null;
  mentions?: Array<SignalMention> | null;
  contacts?: Array<SignalSharedContact> | null;
  pollCreate?: SignalPollCreate | null;
  pollVote?: SignalPollVote | null;
  pollTerminate?: SignalPollTerminate | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: {
    id?: number | string | null;
    timestamp?: number | null;
    text?: string | null;
    authorUuid?: string | null;
    authorNumber?: string | null;
    author?: string | null;
  } | null;
  reaction?: SignalReactionMessage | null;
  expiresInSeconds?: number | null;
  groupV2Change?: Record<string, unknown> | null;
  isExpirationUpdate?: boolean | null;
  remoteDelete?: {
    timestamp?: number | string | null;
    targetSentTimestamp?: number | string | null;
  } | null;
  pinMessage?: (SignalTargetMessageRef & { pinDurationSeconds?: number | null }) | null;
  unpinMessage?: SignalTargetMessageRef | null;
};

export type SignalTargetAuthorObject = {
  number?: string | null;
  e164?: string | null;
  uuid?: string | null;
  aci?: string | null;
  serviceId?: string | null;
};

export type SignalTargetMessageRef = {
  targetAuthor?: string | SignalTargetAuthorObject | null;
  targetAuthorNumber?: string | null;
  targetAuthorE164?: string | null;
  targetAuthorPhone?: string | null;
  targetAuthorUuid?: string | null;
  targetAuthorAci?: string | null;
  targetAuthorServiceId?: string | null;
  targetAuthorId?: string | null;
  targetSentTimestamp?: number | string | null;
};

export type SignalReactionMessage = SignalTargetMessageRef & {
  emoji?: string | null;
  isRemove?: boolean | null;
  remove?: boolean | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
};

export type SignalAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  caption?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
};

export type SignalSticker = {
  packId?: string | number | null;
  stickerId?: string | number | null;
  attachment?: SignalAttachment | null;
};

export type SignalLinkPreview = {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  image?: SignalAttachment | null;
};

export type SignalTextStyleRange = {
  style?: string | null;
  start?: number | null;
  length?: number | null;
};

export type SignalSharedContact = {
  name?: { display?: string | null; given?: string | null; family?: string | null } | null;
  phone?: Array<{ value?: string | null; type?: string | null }> | null;
  email?: Array<{ value?: string | null; type?: string | null }> | null;
  organization?: string | null;
};

export type SignalPollCreate = {
  question?: string | null;
  allowMultiple?: boolean | null;
  options?: Array<string | { text?: string | null } | null> | null;
};

export type SignalPollVote = {
  authorNumber?: string | null;
  authorUuid?: string | null;
  targetSentTimestamp?: number | null;
  optionIndexes?: number[] | null;
  voteCount?: number | null;
};

export type SignalPollTerminate = {
  targetSentTimestamp?: number | null;
};

export type SignalReactionTarget = {
  kind: "phone" | "uuid";
  id: string;
  display: string;
};

export type SignalReceivePayload = {
  envelope?: SignalEnvelope | null;
  exception?: { message?: string } | null;
};

export type SignalEventHandlerDeps = {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  baseUrl: string;
  account?: string;
  accountUuid?: string;
  accountId: string;
  blockStreaming?: boolean;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  textLimit: number;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: GroupPolicy;
  reactionMode: SignalReactionNotificationMode;
  reactionAllowlist: string[];
  mediaMaxBytes: number;
  ignoreAttachments: boolean;
  sendReadReceipts: boolean;
  readReceiptsViaDaemon: boolean;
  injectLinkPreviews?: boolean;
  preserveTextStyles?: boolean;
  fetchAttachment: (params: {
    baseUrl: string;
    account?: string;
    attachment: SignalAttachment;
    sender?: string;
    groupId?: string;
    maxBytes: number;
  }) => Promise<{ path: string; contentType?: string } | null>;
  deliverReplies: (params: {
    replies: ReplyPayload[];
    target: string;
    baseUrl: string;
    account?: string;
    accountId?: string;
    runtime: RuntimeEnv;
    maxBytes: number;
    textLimit: number;
    quoteAuthor?: string;
  }) => Promise<void>;
  resolveSignalReactionTargets: (reaction: SignalReactionMessage) => SignalReactionTarget[];
  isSignalReactionMessage: (
    reaction: SignalReactionMessage | null | undefined,
  ) => reaction is SignalReactionMessage;
  shouldEmitSignalReactionNotification: (params: {
    mode?: SignalReactionNotificationMode;
    account?: string | null;
    targets?: SignalReactionTarget[];
    sender?: SignalSender | null;
    allowlist?: string[];
  }) => boolean;
  buildSignalReactionSystemEventText: (params: {
    emojiLabel: string;
    actorLabel: string;
    messageId: string;
    targetLabel?: string;
    groupLabel?: string;
  }) => string;
};
