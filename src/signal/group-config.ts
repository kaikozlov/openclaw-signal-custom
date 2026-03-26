import type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  OpenClawConfig,
} from "../runtime-api.js";
import {
  resolveSignalAccount,
  type SignalGroupConfig,
} from "../config.js";

export type ResolvedSignalGroupRuntimeConfig = {
  exactConfig?: SignalGroupConfig;
  defaultConfig?: SignalGroupConfig;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  allowFromConfigured: boolean;
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  systemPrompt?: string;
};

function normalizeSignalGroupKey(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^signal-custom:/i, "")
    .replace(/^signal:/i, "")
    .replace(/^(group|channel):/i, "")
    .trim()
    .toLowerCase();
}

function findSignalGroupConfig(
  groups: Record<string, SignalGroupConfig> | undefined,
  groupId: string,
): SignalGroupConfig | undefined {
  if (!groups) {
    return undefined;
  }
  if (groups[groupId]) {
    return groups[groupId];
  }
  const normalizedGroupId = normalizeSignalGroupKey(groupId);
  if (!normalizedGroupId) {
    return undefined;
  }
  const matchedKey = Object.keys(groups).find(
    (key) => key !== "*" && normalizeSignalGroupKey(key) === normalizedGroupId,
  );
  return matchedKey ? groups[matchedKey] : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function resolveSignalGroupRuntimeConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
}): ResolvedSignalGroupRuntimeConfig {
  const groupId = params.groupId?.trim();
  const groups = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).config.groups;
  const exactConfig = groupId ? findSignalGroupConfig(groups, groupId) : undefined;
  const defaultConfig = groups?.["*"];
  const allowFrom = firstDefined(exactConfig?.allowFrom, defaultConfig?.allowFrom);
  return {
    exactConfig,
    defaultConfig,
    enabled: firstDefined(exactConfig?.enabled, defaultConfig?.enabled),
    allowFrom,
    allowFromConfigured:
      Object.hasOwn(exactConfig ?? {}, "allowFrom") || Object.hasOwn(defaultConfig ?? {}, "allowFrom"),
    requireMention: firstDefined(exactConfig?.requireMention, defaultConfig?.requireMention),
    tools: firstDefined(exactConfig?.tools, defaultConfig?.tools),
    toolsBySender: firstDefined(exactConfig?.toolsBySender, defaultConfig?.toolsBySender),
    skills: firstDefined(exactConfig?.skills, defaultConfig?.skills),
    systemPrompt: firstDefined(exactConfig?.systemPrompt, defaultConfig?.systemPrompt),
  };
}

export function resolveSignalAllowlistGroupOverrides(
  groups: Record<string, SignalGroupConfig> | undefined,
): Array<{ label: string; entries: string[] }> {
  const resolvedGroups = groups ?? {};
  return Object.entries(resolvedGroups)
    .flatMap(([groupId, config]) => {
      const entries = (config.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      if (entries.length === 0) {
        return [];
      }
      return [
        {
          label:
            groupId === "*"
              ? "Signal groups (*)"
              : `Signal group ${groupId.replace(/^signal(-custom)?:/i, "").trim()}`,
          entries,
        },
      ];
    });
}
