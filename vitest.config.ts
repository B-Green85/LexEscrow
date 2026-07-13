import { defineConfig } from "vitest/config";

// LexGuard modules are pure deterministic logic — no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
