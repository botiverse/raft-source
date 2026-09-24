import assert from "node:assert/strict";
import test from "node:test";
import { INVALID_EMAIL_MESSAGE, isValidEmailAddress, validateEmailAddress } from "./emailValidation.js";

test("email validation accepts ordinary addresses after trimming", () => {
  assert.equal(isValidEmailAddress("dev@slock.ai"), true);
  assert.equal(isValidEmailAddress("  member.name+tag@example.co.uk  "), true);
  assert.equal(validateEmailAddress("dev@slock.ai"), null);
});

test("email validation rejects malformed invite addresses", () => {
  for (const value of [
    "",
    "not-an-email",
    "missing-domain@",
    "@missing-local.test",
    "missing-dot@example",
    "two@@example.com",
    "has space@example.com",
    "user@example..com",
  ]) {
    assert.equal(isValidEmailAddress(value), false, value);
    assert.equal(validateEmailAddress(value), INVALID_EMAIL_MESSAGE, value);
  }
});
