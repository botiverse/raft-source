import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAppLocalReturnPath } from "./safeReturnPath.js";

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
    "settings",
  ]) {
    assert.equal(sanitizeAppLocalReturnPath(target), "/", target);
  }
});
