import type { APIResponse } from "@playwright/test";

const MAX_BODY_CHARS = 500;

/**
 * Assert an e2e setup/teardown API call succeeded, failing with the status AND
 * the response body.
 *
 * `expect(response.ok()).toBeTruthy()` reports only `Received: false`, which is
 * why seven consecutive `e2e (4)` reds on staging produced no evidence of *why*
 * the request was rejected — 403 (membership revoked by a concurrently running
 * spec), 429, and 500 are indistinguishable after the fact. The server states
 * its reason in the body, so the body is the part worth keeping.
 *
 * Throws rather than using `expect` so the failure carries the label, and so
 * the body is only read on the failure path. Matches the existing fixture
 * convention in `auth.ts` / `session.ts`.
 */
export async function assertApiOk(response: APIResponse, label: string): Promise<void> {
  if (response.ok()) {
    return;
  }

  let body: string;
  try {
    const text = await response.text();
    body =
      text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… (truncated)` : text || "<empty>";
  } catch (error) {
    body = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }

  throw new Error(
    `${label} failed: ${response.status()} ${response.statusText()}\n` +
      `  url:  ${response.url()}\n` +
      `  body: ${body}`,
  );
}
