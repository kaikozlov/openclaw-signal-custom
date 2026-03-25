import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { signalPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(signalPlugin);
