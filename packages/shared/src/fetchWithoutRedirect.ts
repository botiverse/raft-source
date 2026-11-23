// A fetch that never follows a redirect, in every runtime.
//
// `redirect: "error"` would say this directly, but the Cloudflare Workers
// runtime rejects it (only "follow" and "manual" are accepted there), so
// every request failed before it left. "manual" is accepted everywhere: a
// redirect comes back as the 3xx itself (Node, Deno, Bun, Workers) or as an
// opaque redirect with status 0 (browsers). Either one is refused here, the
// same way "error" refused it: the request's credentials never reach the
// redirect's target.

/** `fetchImpl` with `redirect: "manual"`; a redirect answer throws a TypeError, as `redirect: "error"` would. */
export async function fetchWithoutRedirect(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(input, { ...init, redirect: "manual" });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    throw new TypeError(
      `The server answered with a redirect${response.status ? ` (HTTP ${response.status})` : ""}; it is not followed.`,
    );
  }
  return response;
}
