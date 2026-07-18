import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// LexGuard modules are pure deterministic logic — no DOM needed. Screen tests
// render through `react-dom/server`, which also runs fine under the node
// environment; the React plugin is here only to transform their JSX.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
