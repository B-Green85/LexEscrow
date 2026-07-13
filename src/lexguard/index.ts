/**
 * LexGuard Utility Suite — deterministic validation for LexEscrow.
 *
 * Six modules, no probabilistic logic; every check is match-or-discrepancy.
 * Note: `artifact-guard` and the app barrel pull in Tauri IPC, so unit tests
 * import the pure modules directly rather than through this file.
 */
export * from "./types";
export * from "./vdb";
export * from "./payload-diff";
export * from "./anchor-matcher";
export * from "./anomaly-watcher";
export * from "./scope-guard";
export * from "./artifact-guard";
