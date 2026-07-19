import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
/**
 * Demo mode — `vite --mode demo` (spec Task 11).
 *
 * The flag itself comes from `.env.demo`, which Vite loads for this mode. That
 * file is deliberately **tracked in git** despite the `.env.*` ignore rule: it
 * holds no secrets, and it is the thing that routes the eSign layer to
 * `MockDocuSignProvider`. A demo build that silently talked to production
 * DocuSign because an untracked env file was missing would be a bad failure,
 * so the config is committed rather than reconstructed per machine.
 *
 * Note this cannot be done with `define`: the call sites read
 * `import.meta.env?.VITE_DEMO_MODE`, and the optional chaining means the
 * expression never matches a `define` key. `demo/scripts/run_demo.sh` also
 * exports `VITE_DEMO_MODE=true` directly, giving the demo a second, independent
 * path to the same flag.
 */
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
