import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["REFERENCE_UNTRACKED/**", "node_modules/**"],
  },
});
