/**
 * Shared webhook transport for the practice-management integrations.
 *
 * Clio and PracticePanther differ in their event vocabulary and payload shape —
 * which is why they get separate modules — but the delivery mechanics are the
 * same operation: POST JSON, optional bearer token, bounded wait, and a result
 * instead of an exception. Duplicating that in both adapters would mean two
 * places to fix a timeout bug.
 *
 * The never-throw contract is the important part. A webhook is a courtesy copy
 * sent to a system LexEscrow does not control; an unreachable practice-
 * management server must not be able to fail a settlement that has already
 * happened on-chain.
 */

/** Outcome of one delivery attempt. `success` means a 2xx was received. */
export interface WebhookResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/** Spec Task 2 — abandon the request after ten seconds. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * POST `body` as JSON, returning a result rather than throwing.
 *
 * The timeout is enforced with an `AbortController` rather than a racing
 * promise so the underlying request is actually cancelled — a raced timeout
 * would resolve the caller while leaving the socket open.
 */
export async function postWebhook(
  url: string,
  body: unknown,
  apiKey?: string,
): Promise<WebhookResult> {
  if (!url || !url.trim()) {
    return { success: false, error: "No webhook URL configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    return res.ok
      ? { success: true, statusCode: res.status }
      : { success: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    // An abort surfaces here as an ordinary rejection; report it as a timeout
    // rather than a generic network error so a slow endpoint is diagnosable.
    const aborted = controller.signal.aborted;
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: aborted ? `Timed out after ${WEBHOOK_TIMEOUT_MS}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}
