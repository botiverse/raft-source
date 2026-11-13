import assert from "node:assert/strict";
import { test } from "vitest";
import { forgetLimitResetAttemptKey, limitResetAttemptKey } from "../limitResetAttemptKey";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => { items.set(name, value); },
    removeItem: (name: string) => { items.delete(name); },
  };
}

test("an attempt's key outlives a reload until the outcome settles", () => {
  const storage = memoryStorage();
  const first = limitResetAttemptKey("server\0machine\0codex", storage);
  assert.equal(limitResetAttemptKey("server\0machine\0codex", storage), first, "a retry after a reload sends the same key");
  assert.notEqual(limitResetAttemptKey("server\0other\0codex", storage), first, "another Computer never inherits it");
  forgetLimitResetAttemptKey("server\0machine\0codex", storage);
  assert.notEqual(limitResetAttemptKey("server\0machine\0codex", storage), first, "a new attempt after a settled outcome gets a new key");
});

test("without storage the key still works for the page's life", () => {
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  const first = limitResetAttemptKey("s\0m\0codex", broken);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(limitResetAttemptKey("s\0m\0codex", broken), first, "a retry on the same page sends the same key");
  forgetLimitResetAttemptKey("s\0m\0codex", broken);
  assert.notEqual(limitResetAttemptKey("s\0m\0codex", broken), first);
});
