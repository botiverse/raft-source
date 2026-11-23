import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchWithoutRedirect } from "./fetchWithoutRedirect";

test("asks for redirect \"manual\", keeps the rest of init, and passes a non-redirect answer through", async () => {
  let seen: RequestInit | undefined;
  const ok = new Response("{}", { status: 200 });
  const response = await fetchWithoutRedirect(async (_input, init) => {
    seen = init;
    return ok;
  }, "https://raft.example/x", { method: "POST", cache: "no-store", redirect: "follow" });
  assert.equal(response, ok);
  assert.equal(seen?.redirect, "manual", "a caller's redirect is overridden");
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.cache, "no-store");
});

test("every 3xx and a browser's opaque redirect throw a TypeError, as redirect \"error\" does; 4xx and 5xx pass through", async () => {
  for (const status of [300, 301, 302, 303, 307, 308]) {
    const answer = new Response(null, { status, headers: { location: "https://elsewhere.example" } });
    await assert.rejects(fetchWithoutRedirect(async () => answer, "https://raft.example/x"), (e: unknown) => e instanceof TypeError && e.message.includes(`HTTP ${status}`));
  }
  const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" }) as Response;
  await assert.rejects(fetchWithoutRedirect(async () => opaque, "https://raft.example/x"), TypeError);
  for (const status of [400, 401, 403, 404, 500]) {
    const answer = new Response(null, { status });
    assert.equal(await fetchWithoutRedirect(async () => answer, "https://raft.example/x"), answer);
  }
});
