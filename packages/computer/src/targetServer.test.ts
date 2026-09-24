import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AddressInfo } from "node:net";

import { serverAttachmentPath } from "./paths.js";
import { resolveTargetServerId } from "./targetServer.js";
import { CliExit } from "./output.js";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-target-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => { buf += String(c); return true; });
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = oo; process.stderr.write = oe; }, text: () => buf };
}

async function writeAttach(
  home: string,
  serverId: string,
  serverSlug: string,
  serverUrl: string = "http://127.0.0.1:1",
): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "computer-attachment",
    serverId,
    serverSlug,
    serverMachineId: `cm-${serverId}`,
    apiKey: `sk_computer_${serverId}`,
    serverUrl,
  }));
}

/** Spin up an in-process HTTP server that mimics `/internal/computer/preflight`
 * returning a configurable `serverSlug`. Lets us pin the §10 slug-rename
 * invariant without depending on a real Slock server. */
async function withFakePreflight<T>(
  freshSlug: string,
  fn: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/internal/computer/preflight" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, serverSlug: freshSlug }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("resolveTargetServerId: user-facing selector resolves slug to canonical serverId", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "alpha");
    await writeAttach(home, SERVER_B, "beta");
    assert.equal(await resolveTargetServerId({ server: "beta" }), SERVER_B);
  });
});

test("resolveTargetServerId: canonical `/<slug>` and shorthand `<slug>` resolve to the same serverId", async () => {
  // Locks the tygg/Jianwei/liuliu convergence in #wg-raft-computer:a0997b57
  // (msg=1dbc346d / msg=8e9116d7 / msg=3e4a2439): `/<slug>` is the
  // canonical user-facing form; bare `<slug>` is accepted shorthand;
  // both must lookup to the same attachment. Stored slug stays bare.
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "alpha");
    assert.equal(await resolveTargetServerId({ server: "alpha" }), SERVER_A);
    assert.equal(await resolveTargetServerId({ server: "/alpha" }), SERVER_A);
    assert.equal(await resolveTargetServerId({ server: "  /alpha  " }), SERVER_A);
  });
});

test("resolveTargetServerId: UUID-shaped input is not accepted as a serverId alias", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "alpha");
    const cap = captureOut();
    try {
      await assert.rejects(
        () => resolveTargetServerId({ server: SERVER_A }),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NOT_ATTACHED/);
    assert.doesNotMatch(cap.text(), /valid server id|UUID/i);
  });
});

test("resolveTargetServerId: multiple attached servers ask for server slug", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "alpha");
    await writeAttach(home, SERVER_B, "beta");
    const cap = captureOut();
    try {
      await assert.rejects(
        () => resolveTargetServerId({}),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /AMBIGUOUS_SERVER/);
    assert.match(cap.text(), /Pass the server slug positionally/);
    assert.match(cap.text(), /\/alpha/);
    assert.match(cap.text(), /\/beta/);
  });
});

test("resolveTargetServerId: slug rename — local cache stale, preflight refreshes runner.state.json", async () => {
  // §10 invariant (liuliu msg=be8ff5b8 review ask on `cbfdcce9`): a server
  // admin renames slug `alpha` → `beta` while the local runner.state.json
  // still records `alpha`. The user invokes `--server beta`. First lookup
  // misses, `listAttachmentsWithFreshSlugs` hits preflight, learns the
  // fresh slug, rewrites runner.state.json, retry succeeds. Disk path is
  // still keyed by serverId — the rename does not move local state.
  await withFakePreflight("beta", async (serverUrl) => {
    await withHome(async (home) => {
      await writeAttach(home, SERVER_A, "alpha", serverUrl);
      assert.equal(await resolveTargetServerId({ server: "beta" }), SERVER_A);
      const refreshed = JSON.parse(
        await readFile(serverAttachmentPath(home, SERVER_A), "utf8"),
      );
      assert.equal(refreshed.serverSlug, "beta");
      assert.equal(refreshed.serverId, SERVER_A);
    });
  });
});

test("resolveTargetServerId: NOT_ATTACHED error renders canonical `/<slug>` form", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "alpha");
    const cap = captureOut();
    try {
      await assert.rejects(
        () => resolveTargetServerId({ server: "ghost" }),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NOT_ATTACHED/);
    // Asks for the canonical `/<slug>` form; bare slug must not appear
    // outside that prefix in the actionable string.
    assert.match(cap.text(), /\/ghost/);
    assert.match(cap.text(), /\/alpha/);
  });
});
