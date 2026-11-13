import assert from "node:assert/strict";
import { MAX_APP_LOCAL_RETURN_PATH_LENGTH, sanitizeAppLocalReturnPath } from "./safeReturnPath";

test("sanitizeAppLocalReturnPath preserves normalized local paths", () => {
  assert.equal(
    sanitizeAppLocalReturnPath("/settings?tab=account#connected-apps"),
    "/settings?tab=account#connected-apps",
  );
});

test("sanitizeAppLocalReturnPath rejects external and parser-ambiguous targets", () => {
  for (const target of [
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example/x",
    "/%5cevil.example/x",
    "/%5Cevil.example/x",
    "/%2e%2e//evil.example/x",
    "/a/..//evil.example/x",
    "/\t/evil.example/x",
    "/artifacts/x\n",
    "settings",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "https:/evil.example",
    "",
  ]) {
    assert.equal(sanitizeAppLocalReturnPath(target), "/", target);
  }
});

test("sanitizeAppLocalReturnPath keeps an Artifact link and drops a path over the length cap", () => {
  assert.equal(sanitizeAppLocalReturnPath("/artifacts/pt_abc/v/2?c=1#top"), "/artifacts/pt_abc/v/2?c=1#top");
  const longest = `/${"a".repeat(MAX_APP_LOCAL_RETURN_PATH_LENGTH - 1)}`;
  assert.equal(sanitizeAppLocalReturnPath(longest), longest);
  assert.equal(sanitizeAppLocalReturnPath(`${longest}a`), "/");
  // Normalizing (percent-encoding a space) can't push it past the cap either.
  assert.equal(sanitizeAppLocalReturnPath(`/${" ".repeat(MAX_APP_LOCAL_RETURN_PATH_LENGTH - 10)}`), "/");
  assert.equal(sanitizeAppLocalReturnPath(42), "/");
  assert.equal(sanitizeAppLocalReturnPath(null), "/");
});
