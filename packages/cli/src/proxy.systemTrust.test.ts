// The agent CLI trusts the OS certificate store lazily: only once a request
// targets an HTTPS server directly (an attachment's object-storage redirect,
// self-hosted mode, `raft agent login`), never for the plain-http loopback
// calls of a managed agent, which must stay cheap.
import assert from "node:assert/strict";
import http from "node:http";

import { buildFetchDispatcher, undiciFetch } from "./proxy";

const systemTrust = vi.hoisted(() => ({ installs: 0 }));
vi.mock("@botiverse/raft-shared/src/systemTrust", () => ({
  installSystemCaTrust: () => {
    systemTrust.installs += 1;
    return { status: "unsupported", durationMs: 0 };
  },
}));

test("system CA trust is installed before the first direct HTTPS request, and never for loopback http", async () => {
  const loopback = http.createServer((_request, response) => {
    response.writeHead(200, { connection: "close" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  const address = loopback.address();
  assert.ok(address && typeof address !== "string");
  const loopbackUrl = `http://127.0.0.1:${address.port}/internal/agent-api/`;

  try {
    assert.equal(await buildFetchDispatcher(loopbackUrl, {}), undefined);
    assert.equal(await (await undiciFetch(loopbackUrl)).text(), "ok");
    assert.equal(systemTrust.installs, 0);

    // Attachment redirect / self-hosted request: buildFetchDispatcher runs first.
    assert.equal(await buildFetchDispatcher("https://objects.example.com/a.png", {}), undefined);
    assert.equal(systemTrust.installs, 1);

    // `raft agent login` style direct undici fetch: still once per process.
    await assert.rejects(undiciFetch("https://127.0.0.1:1/internal/agent-api/"));
    assert.equal(systemTrust.installs, 1);
  } finally {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
  }
});

test("a direct undici fetch to an HTTPS server installs trust before connecting", async () => {
  vi.resetModules();
  systemTrust.installs = 0;
  const fresh = await import("./proxy");
  await assert.rejects(fresh.undiciFetch("https://127.0.0.1:1/api/auth/device/authorize"));
  assert.equal(systemTrust.installs, 1);
});
