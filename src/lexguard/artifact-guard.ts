// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * artifact-guard — the LexGuard bridge to the Rust ArtifactGuard over Tauri IPC.
 *
 * Hashing and normalization always run in the Rust backend, never in the
 * WebView. Bytes are passed as a plain number array so serde deserializes them
 * straight into `Vec<u8>`.
 */

import { invoke } from "@tauri-apps/api/core";

export interface LoadedArtifact {
  filename: string;
  hash: string;
  size: number;
  normalizedText: string;
}

const toByteArray = (bytes: Uint8Array): number[] => Array.from(bytes);

/**
 * Load an artifact: register its SHA-256 baseline in the backend and return the
 * hash plus the normalized UTF-8 text stream for the VDB / AI / LexGuard.
 */
export async function loadArtifact(filename: string, bytes: Uint8Array): Promise<LoadedArtifact> {
  return invoke<LoadedArtifact>("load_artifact", { filename, bytes: toByteArray(bytes) });
}

/** Register (or re-register) an artifact's integrity baseline; returns the hash. */
export async function registerArtifact(filename: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>("register_artifact", { filename, bytes: toByteArray(bytes) });
}

/** Non-blocking integrity check at an intermediate stage. */
export async function verifyArtifact(filename: string, bytes: Uint8Array): Promise<boolean> {
  return invoke<boolean>("verify_artifact", { filename, bytes: toByteArray(bytes) });
}

/**
 * Blocking final re-verify, called synchronously on *Proceed to Execution*.
 * Rejects with `{ reason }` if the artifact changed since parsing.
 */
export async function finalVerifyBeforeExecution(filename: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>("final_verify_before_execution", { filename, bytes: toByteArray(bytes) });
}

/** Normalize arbitrary text using the same backend routine as artifact load. */
export async function normalizeText(raw: string): Promise<string> {
  return invoke<string>("normalize_text", { raw });
}
