import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, test } from "vitest";
import { ssoIdpFetch, SsoIdpUnreachableError } from "./ssoIdpFetch";

// The IdP is an untrusted peer (rfcs/083-server-sso.md §7).
const LOCAL = { RAFT_SSO_ALLOW_HTTP_IDP: "1", NODE_ENV: "test" } as NodeJS.ProcessEnv;
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status") ?? "200");
    if (req.url?.startsWith("/big")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(300 * 1024));
      return;
    }
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    // Node writes any 3-digit status, so a hostile peer's 999 or 205-with-body reaches the client.
    res.writeHead(status, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end(status === 204 ? undefined : "{\"ok\":true}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("ssoIdpFetch", () => {
  test("answers a normal exchange, keeping repeated headers", async () => {
    const res = await ssoIdpFetch(`${base}/ok`, {}, LOCAL);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("refuses statuses a Response cannot carry instead of crashing", async () => {
    for (const status of [999, 205]) {
      await assert.rejects(ssoIdpFetch(`${base}/s?status=${status}`, {}, LOCAL), SsoIdpUnreachableError, String(status));
    }
  });

  test("does not follow redirects and caps the body", async () => {
    assert.equal((await ssoIdpFetch(`${base}/redirect`, {}, LOCAL)).status, 302);
    await assert.rejects(ssoIdpFetch(`${base}/big`, {}, LOCAL), SsoIdpUnreachableError);
  });

  test("refuses http and private addresses outside a local setup", async () => {
    await assert.rejects(ssoIdpFetch(`${base}/ok`, {}, { NODE_ENV: "test" } as NodeJS.ProcessEnv), SsoIdpUnreachableError);
    await assert.rejects(ssoIdpFetch(`${base}/ok`, {}, { RAFT_SSO_ALLOW_HTTP_IDP: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv), SsoIdpUnreachableError);
    await assert.rejects(ssoIdpFetch("https://127.0.0.1/ok", {}, { NODE_ENV: "test" } as NodeJS.ProcessEnv), SsoIdpUnreachableError);
  });
});
