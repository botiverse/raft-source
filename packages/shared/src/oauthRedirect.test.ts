import assert from "node:assert/strict";
import { test } from "node:test";
import { appendOAuthAuthorizationParams, isSafeOAuthReturnUrl } from "./oauthRedirect.js";

test("OAuth navigation rejects executable, relative and non-TLS remote callbacks", () => {
  for (const url of [
    "javascript:window.auditExecuted=true//", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)",
    "data:text/html,test", "//attacker.test/cb", "/cb", "http://attacker.test/cb",
    "https://user:password@client.test/cb", "https://client.test/cb#fragment", "http://localhost.attacker.test/cb",
  ]) {
    assert.equal(isSafeOAuthReturnUrl(url), false, url);
    assert.throws(() => appendOAuthAuthorizationParams(url, "secret-code"), /returnUrl/);
  }
});

test("OAuth navigation preserves registered callback query and encodes code/state", () => {
  for (const callback of ["https://client.test/cb?source=raft", "http://localhost:3000/cb", "http://127.0.0.1:3000/cb", "http://[::1]:3000/cb"]) {
    assert.ok(isSafeOAuthReturnUrl(callback));
    const result = new URL(appendOAuthAuthorizationParams(callback, "code&value", "state#value"));
    assert.equal(result.searchParams.get("code"), "code&value");
    assert.equal(result.searchParams.get("state"), "state#value");
    assert.equal(result.origin, new URL(callback).origin);
  }
});
