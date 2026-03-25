import { createPluginRuntimeStore, type PluginRuntime } from "./runtime-api.js";

const { setRuntime: setSignalRuntime, getRuntime: getSignalRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Signal runtime not initialized");

export { getSignalRuntime, setSignalRuntime };
