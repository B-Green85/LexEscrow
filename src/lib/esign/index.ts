/**
 * eSign layer barrel + provider resolver.
 */

import * as backend from "../backend";
import { DocuSignProvider } from "./docusign-provider";
import { MockDocuSignProvider } from "./mock-docusign-provider";
import type { eSignProvider } from "./types";

export * from "./types";
export { DocuSignProvider, TauriRequiredError } from "./docusign-provider";
export {
  MockDocuSignProvider,
  DEMO_ENVELOPE_PREFIX,
  DEMO_CERTIFICATE_TEXT,
} from "./mock-docusign-provider";

/** One mock instance per process — envelope timestamps must survive between polls. */
const mockProvider = new MockDocuSignProvider();

export function isDemoMode(): boolean {
  return import.meta.env?.VITE_DEMO_MODE === "true" || !backend.isTauri();
}

/**
 * Pick the provider for this environment.
 *
 * Demo mode and plain-browser builds always get the mock. Under Tauri the real
 * provider is used only when the vault actually holds usable DocuSign
 * credentials; otherwise we fall back to the mock rather than failing the
 * workflow. That fallback is *visible* — `providerName()` reports
 * "DocuSign (demo)" and the Condition Definition screen renders it — so a
 * simulated signature can never be mistaken for a real one.
 */
export async function resolveESignProvider(): Promise<eSignProvider> {
  if (isDemoMode()) return mockProvider;
  try {
    const configured = await backend.hasDocuSign();
    return configured ? new DocuSignProvider() : mockProvider;
  } catch {
    // A locked vault throws — treat it as "not configured".
    return mockProvider;
  }
}

/** Test/demo helper — clears mock envelope state. */
export function resetMockESignProvider(): void {
  mockProvider.reset();
}
