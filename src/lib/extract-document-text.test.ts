// @vitest-environment jsdom
/**
 * The `extractDocumentText` bridge.
 *
 * What matters here is the failure policy, not the happy path — the extraction
 * itself is Rust and is tested there. Suggestion is advisory, so this bridge is
 * required never to throw: an unreadable document must cost the officer some
 * typing, never an error they have to dismiss before they can continue. These
 * tests pin that contract on both sides of the Tauri boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDocumentText, extractDocumentTextAtPath, isTauri } from "./backend";

const bytes = (s: string) => new TextEncoder().encode(s);

/** Install a fake Tauri IPC surface and return the invoke spy. */
function withTauri(impl: (cmd: string, args: unknown) => unknown) {
  const invoke = vi.fn(impl);
  // `isTauri()` keys off this, and @tauri-apps/api/core dispatches through it.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown) => Promise.resolve(invoke(cmd, args)),
    transformCallback: (cb: unknown) => cb,
  };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("extractDocumentText — outside Tauri", () => {
  it("is not running under Tauri in this environment", () => {
    expect(isTauri()).toBe(false);
  });

  it("reads .txt and .md directly in the browser", async () => {
    await expect(extractDocumentText("doc.txt", bytes("Bar No. 123456"))).resolves.toBe(
      "Bar No. 123456",
    );
    await expect(extractDocumentText("notes.MD", bytes("# Client: Jane"))).resolves.toBe(
      "# Client: Jane",
    );
  });

  it("returns empty for formats only the backend can read", async () => {
    // Decoding PDF/DOCX bytes in the WebView yields binary noise, which is
    // worse than nothing: it can only produce spurious matches.
    for (const name of ["deal.pdf", "deal.docx", "terms.xlsx", "photo.jpg"]) {
      await expect(extractDocumentText(name, bytes("%PDF-1.4 binary"))).resolves.toBe("");
    }
  });

  it("returns empty rather than throwing at a path", async () => {
    await expect(extractDocumentTextAtPath("/tmp/nope.txt")).resolves.toBe("");
  });
});

describe("extractDocumentText — under Tauri", () => {
  it("sends the file name and bytes to the extractor command", async () => {
    const invoke = withTauri(() => "Purchase Price: $485,000.00");

    const text = await extractDocumentText("deal.pdf", bytes("%PDF"));

    expect(text).toBe("Purchase Price: $485,000.00");
    expect(invoke).toHaveBeenCalledWith(
      "extract_document_text_bytes",
      expect.objectContaining({ fileName: "deal.pdf", fileBytes: [37, 80, 68, 70] }),
    );
  });

  it("returns empty instead of throwing when the command rejects", async () => {
    withTauri(() => {
      throw new Error("extractor panicked");
    });

    await expect(extractDocumentText("deal.pdf", bytes("%PDF"))).resolves.toBe("");
  });

  it("passes an empty extraction through unchanged", async () => {
    withTauri(() => "");
    await expect(extractDocumentText("photo.jpg", bytes("junk"))).resolves.toBe("");
  });

  it("swallows a missing-file error from the path variant", async () => {
    const invoke = withTauri(() => {
      throw "File not found";
    });

    await expect(extractDocumentTextAtPath("/tmp/gone.pdf")).resolves.toBe("");
    expect(invoke).toHaveBeenCalledWith(
      "extract_document_text",
      expect.objectContaining({ filePath: "/tmp/gone.pdf" }),
    );
  });
});
