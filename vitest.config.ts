import { defineConfig } from "vitest/config";

// The helpers under test are pure TS with no Tauri or DOM dependency, so the
// suite runs in a plain Node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
