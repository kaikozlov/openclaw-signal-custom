import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { signalPlugin } from "./src/channel.js";
import { setSignalRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "signal-custom",
  name: "Signal Custom",
  description: "Signal channel plugin (custom fork baseline)",
  plugin: signalPlugin,
  setRuntime: setSignalRuntime,
});
