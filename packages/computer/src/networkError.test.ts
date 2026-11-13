import assert from "node:assert/strict";

import { describeNetworkError, formatCliFatalError, isTransientNetworkError } from "./networkError";
import { ComputerServiceError } from "./services/errors";

function fetchFailed(...codes: string[]): TypeError {
  let cause: Error | undefined;
  for (const code of [...codes].reverse()) {
    cause = Object.assign(new Error(`secret detail http://user:pass@proxy.example:8080 (${code})`), { code, ...(cause ? { cause } : {}) });
  }
  return new TypeError("fetch failed", cause ? { cause } : undefined);
}

test("network error: a dropped connection, DNS failure or timeout is transient; TLS and plain errors are not", () => {
  assert.equal(isTransientNetworkError(fetchFailed("UND_ERR_SOCKET", "ECONNRESET")), true);
  assert.equal(isTransientNetworkError(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(isTransientNetworkError(fetchFailed("EAI_AGAIN")), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
  assert.equal(isTransientNetworkError(fetchFailed("CERT_HAS_EXPIRED")), false);
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), false);
  assert.equal(isTransientNetworkError(Object.assign(new Error("a"), { name: "AbortError" })), false);
});

test("cli fatal line: a cause adds its code only, and a bare fetch failure adds the proxy hint", () => {
  const out = formatCliFatalError(fetchFailed("UND_ERR_SOCKET", "ECONNRESET"));
  const [first, second] = out.split("\n");
  assert.equal(first, "raft-computer: fetch failed (UND_ERR_SOCKET/ECONNRESET)");
  assert.match(second, /HTTPS_PROXY \/ HTTP_PROXY \/ NO_PROXY/);
  assert.match(second, /run the same command again/);
  assert.doesNotMatch(out, /secret|user:pass/);
  assert.equal(describeNetworkError(fetchFailed("ECONNRESET")), "ECONNRESET");
});

test("cli fatal line: plain errors and service errors print their message only", () => {
  assert.equal(formatCliFatalError(new Error("boom")), "raft-computer: boom\n");
  assert.equal(formatCliFatalError("str"), "raft-computer: str\n");
  const svc = new ComputerServiceError("LOGIN_FAILED", "Login failed.", fetchFailed("ECONNRESET"));
  assert.equal(formatCliFatalError(svc), "raft-computer: Login failed.\n");
});
