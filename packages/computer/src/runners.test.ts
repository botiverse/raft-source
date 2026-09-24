import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { runRunnersList, runRunnersStop } from "./runners.js";
import { serverAttachmentPath } from "./paths.js";
import { CliExit } from "./output.js";

// task #30 PR-G regression — `runners list|stop` per-server scoping
// (v4 §6: ≥2 attached → positional serverSlug required, fail-loud list
// candidates; 0 attached → NO_ATTACHMENT). Plus the SECRET REDLINE
// (sk_computer_* never echoed even on error).

const SECRET_KEY = "sk_computer_RUNNERS-MUST-NOT-PRINT-abc999";
const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const SLUG_A = "alpha";
const SLUG_B = "beta";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-runners-"));
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

async function withRunnerServer<T>(
  handler: (req: { url: string; authorization: string }) => unknown,
  fn: (baseUrl: string, calls: Array<{ url: string; authorization: string }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ url: string; authorization: string }> = [];
  const server = createHttpServer((req, res) => {
    const call = { url: req.url ?? "", authorization: String(req.headers.authorization ?? "") };
    calls.push(call);
    const body = handler(call) ?? { whitelist: [], runners: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function writeAttach(
  home: string,
  serverId: string,
  apiKey: string,
  serverSlug = `slug-${serverId.slice(0, 8)}`,
  serverUrl = "http://127.0.0.1:1",
): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "computer-attachment",
    serverId,
    serverSlug,
    serverMachineId: `cm-${serverId}`,
    apiKey,
    serverUrl,
  }));
}

test("runners list: no attachments → fail-closed NO_ATTACHMENT", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(() => runRunnersList({}), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NO_ATTACHMENT/);
  });
});

test("runners list: default lists this Computer across attached servers without AMBIGUOUS_SERVER", async () => {
  await withHome(async (home) => {
    await withRunnerServer(
      ({ authorization }) => ({
        whitelist: ["agentId", "name", "status", "model", "runtime"],
        runners: authorization.includes("sk_computer_x")
          ? [{ agentId: "agent-a", name: "Agent A", status: "active", runtime: "claude", model: "sonnet" }]
          : [{ agentId: "agent-b", name: "Agent B", status: "active", runtime: "codex", model: "gpt-5" }],
      }),
      async (serverUrl, calls) => {
        await writeAttach(home, SERVER_A, "sk_computer_x", SLUG_A, serverUrl);
        await writeAttach(home, SERVER_B, "sk_computer_y", SLUG_B, serverUrl);
        const cap = captureOut();
        try {
          await runRunnersList({});
        } finally {
          cap.restore();
        }
        const out = cap.text();
        assert.match(out, /Server \/alpha:/);
        assert.match(out, /Server \/beta:/);
        assert.match(out, /agent-a/);
        assert.match(out, /agent-b/);
        assert.equal(calls.length, 2);
        assert.ok(calls.every((call) => !call.url.includes("scope=server")), "default must use machine-scoped server endpoint");
      },
    );
  });
});

test("runners list --all: ≥2 attached without serverSlug → AMBIGUOUS_SERVER, fail-loud lists candidates", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "sk_computer_x", SLUG_A);
    await writeAttach(home, SERVER_B, "sk_computer_y", SLUG_B);
    const cap = captureOut();
    try {
      await assert.rejects(() => runRunnersList({ all: true }), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.match(out, /AMBIGUOUS_SERVER/);
    assert.ok(out.includes(SLUG_A) && out.includes(SLUG_B), "should list candidates");
  });
});

test("runners list --all: single selected server uses legacy server-wide scope", async () => {
  await withHome(async (home) => {
    await withRunnerServer(
      () => ({
        whitelist: ["agentId", "name", "status", "model", "runtime"],
        runners: [{ agentId: "agent-a", name: "Agent A", status: "active", runtime: "claude", model: "sonnet" }],
      }),
      async (serverUrl, calls) => {
        await writeAttach(home, SERVER_A, "sk_computer_x", SLUG_A, serverUrl);
        const cap = captureOut();
        try {
          await runRunnersList({ all: true });
        } finally {
          cap.restore();
        }
        assert.match(cap.text(), /agent-a/);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes("scope=server"), "--all must preserve the legacy server-wide endpoint");
      },
    );
  });
});

test("runners list: serverSlug pointing at unattached server → NOT_ATTACHED", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "sk_computer_x", SLUG_A);
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runRunnersList({ server: SLUG_B }),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NOT_ATTACHED/);
  });
});

test("runners stop: same fail-closed semantics — agentId required + serverSlug resolution", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(() => runRunnersStop(""), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /AGENT_ID_REQUIRED/);
  });
});

test("runners stop: error path never echoes the sk_computer_* key", async () => {
  // Single attachment (omit serverSlug allowed). Port 1 → reach an error
  // path quickly without real network success; assert the key is not in
  // ANY output, regardless of which error variant is thrown.
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY);
    const cap = captureOut();
    let threw = false;
    try {
      try {
        await runRunnersStop("agent-x");
      } catch {
        threw = true;
      }
    } finally {
      cap.restore();
    }
    assert.equal(threw, true, "expected runners stop to fail when the server is unreachable");
    const out = cap.text();
    assert.ok(!out.includes(SECRET_KEY), "leaked sk_computer_* on error path");
  });
});
