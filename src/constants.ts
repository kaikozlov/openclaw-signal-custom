import type { ChannelMeta } from "openclaw/plugin-sdk";

export const SIGNAL_CHANNEL_ID = "signal-custom";
export const SIGNAL_LEGACY_CHANNEL_ID = "signal";

export const SIGNAL_META: ChannelMeta = {
  id: SIGNAL_CHANNEL_ID,
  label: "Signal Custom",
  selectionLabel: "Signal Custom (signal-cli)",
  detailLabel: "Signal Custom",
  docsPath: "/channels/signal",
  docsLabel: "signal",
  blurb: "standalone Signal channel plugin with custom signal-cli transport and actions.",
  systemImage: "antenna.radiowaves.left.and.right",
};

export function stripSignalChannelPrefix(raw: string): string {
  return raw.replace(/^signal-custom:/i, "").replace(/^signal:/i, "").trim();
}
