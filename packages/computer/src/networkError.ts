// Naming network failures without leaking them. undici reports every
// transport failure as a bare `TypeError: fetch failed`; the real reason is a
// code along `error.cause` (ECONNRESET, UND_ERR_SOCKET, ENOTFOUND, …). Only
// those codes are ever shown: a cause's message can carry a proxy URL with
// credentials, so it is never printed.

/**
 * What actually failed under undici's bare "fetch failed": the codes and
 * names along `error.cause` (ECONNRESET, UND_ERR_SOCKET, a TLS code, …).
 */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    const label = typeof code === "string" && code
      ? code
      : typeof name === "string" && name !== "Error" && name !== "TypeError" ? name : null;
    if (label && !parts.includes(label)) parts.push(label.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48));
    current = cause;
  }
  return parts.join("/") || "network_error";
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * A failure of the connection itself (reset, refused, DNS, an undici socket
 * or connect timeout, a per-request timeout) that the next attempt may not
 * hit. An answer from the server, a TLS/certificate failure or a user abort
 * is not one.
 */
export function isTransientNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === "string" && (TRANSIENT_CODES.has(code) || code.startsWith("UND_ERR_"))) return true;
    if (name === "TimeoutError") return true;
    current = cause;
  }
  return false;
}

/** The one line of advice for a request that never got an answer. */
export const NETWORK_FAILURE_HINT =
  "Check your network/VPN; if you need a proxy, set HTTPS_PROXY / HTTP_PROXY / NO_PROXY.";

/**
 * The CLI's last-resort line for an error nothing else rendered. An error
 * carrying a `cause` gets the cause's code appended (never its message); a
 * bare undici "fetch failed" gets the network hint on its own line. A
 * ComputerServiceError's cause is never forwarded (services/errors.ts): its
 * message is already the user-facing text.
 */
export function formatCliFatalError(err: unknown): string {
  if (!(err instanceof Error)) return `raft-computer: ${String(err)}\n`;
  const forwardsCause = err.cause !== undefined && err.name !== "ComputerServiceError";
  const suffix = forwardsCause ? ` (${describeNetworkError(err.cause)})` : "";
  let out = `raft-computer: ${err.message}${suffix}\n`;
  if (err instanceof TypeError && err.message === "fetch failed") {
    out += `raft-computer: the request to the server never got an answer. ${NETWORK_FAILURE_HINT} Then run the same command again.\n`;
  }
  return out;
}
