import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import api from "../src/api/client.js";

class MemoryStorage {
  private readonly values = new Map<string, string>([["slock_access_token", "inbox-pressure-token"]]);

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

function overloadError(config: InternalAxiosRequestConfig): AxiosError {
  return new AxiosError(
    "HTTP 429",
    "ERR_BAD_REQUEST",
    config,
    undefined,
    {
      config,
      data: { error: "Inbox is busy; retry later", code: "INBOX_BACKPRESSURE" },
      headers: { "retry-after": "1" },
      status: 429,
      statusText: "Too Many Requests",
    },
  );
}

test("shared inbox client preserves closed overload metadata and does not blindly retry 429", async () => {
  let attempts = 0;

  const rejection = await api.get("/channels/inbox", {
    adapter: async (config) => {
      attempts += 1;
      throw overloadError(config);
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(rejection instanceof AxiosError);
  assert.equal(rejection.response?.status, 429);
  assert.equal(rejection.response?.headers.get("retry-after"), "1");
  assert.deepEqual(rejection.response?.data, {
    error: "Inbox is busy; retry later",
    code: "INBOX_BACKPRESSURE",
  });
  assert.equal(attempts, 1, "the shared client must not turn a route 429 into an immediate retry loop");

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(attempts, 1, "Retry-After is caller-visible metadata, not an automatic blind retry");
});
