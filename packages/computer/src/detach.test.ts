// `raft-computer detach <server>` (device-auth §3.2): the server revokes this
// machine's key first; the local credential goes only after the server
// confirms (or a second check confirms the server already refuses it).
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runDetach, type DetachDeps } from "./detach";
import { CliExit } from "./output";
import {
  legacyServerAttachmentPath,
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverManagedFlagPath,
  serverRunnerLockConflictPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
} from "./paths";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "sk_computer_detach-current-key";
const OLD_KEY = "sk_computer_detach-older-key";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Reply = { status: number; body: Record<string, unknown> };
type Route = (key: string | undefined) => Reply;

async function withFakeServer<T>(
  routes: { detach: Route; preflight?: Route },
  fn: (ctx: { url: string; calls: Array<{ path: string; key: string | undefined; localFileExisted: boolean }>; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-detach-"));
  const calls: Array<{ path: string; key: string | undefined; localFileExisted: boolean }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const key = req.headers.authorization?.replace(/^Bearer /, "");
    const path = req.url ?? "";
    calls.push({ path, key, localFileExisted: existsSync(serverAttachmentPath(home, SERVER_ID)) });
    const route = path === "/internal/computer/detach" ? routes.detach
      : path === "/internal/computer/preflight" ? routes.preflight
      : undefined;
    const reply = route ? route(key) : { status: 404, body: {} };
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn({ url, calls, home });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

async function writeAttachment(home: string, path: string, apiKey: string, serverUrl: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    kind: "computer-attachment",
    serverId: SERVER_ID,
    serverSlug: "alpha",
    serverMachineId: "computer-1",
    machineId: "22222222-2222-4222-8222-222222222222",
    apiKey,
    serverUrl,
  }), { mode: 0o600 });
}

async function attach(home: string, url: string): Promise<void> {
  await writeAttachment(home, serverAttachmentPath(home, SERVER_ID), KEY, url);
  await writeFile(serverManagedFlagPath(home, SERVER_ID), "");
}

function deps(home: string, lines: string[], extra: Partial<DetachDeps> = {}): DetachDeps {
  return {
    resolveRaftHome: () => home,
    resolveTargetServerId: async () => SERVER_ID,
    isInteractive: () => false,
    waitForRunnerExit: async () => true,
    info: (line) => lines.push(line),
    ...extra,
  };
}

async function failsWith(code: string, run: () => Promise<void>): Promise<void> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await assert.rejects(run(), (err: unknown) => err instanceof CliExit && err.code === code);
  } finally {
    process.stderr.write = write;
  }
}

function localStateKept(home: string): void {
  assert.ok(existsSync(serverAttachmentPath(home, SERVER_ID)), "runner.state.json kept");
  assert.ok(existsSync(serverManagedFlagPath(home, SERVER_ID)), "managed flag kept");
}

test("detach revokes on the server first, then removes the local key and managed flag", async () => {
  await withFakeServer({ detach: () => ({ status: 200, body: { ok: true } }) }, async ({ url, calls, home }) => {
    await attach(home, url);
    const lines: string[] = [];
    await runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines));
    assert.deepEqual(calls, [{ path: "/internal/computer/detach", key: KEY, localFileExisted: true }]);
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)), "runner.state.json removed");
    assert.ok(!existsSync(serverManagedFlagPath(home, SERVER_ID)), "managed flag cleared");
    assert.match(lines.join("\n"), /Revoked this machine's key on \/alpha/);
    assert.match(lines.join("\n"), /raft-computer attach \/alpha/);
  });
});

test("detach says which lock owner it left alone when the service had deferred to one, and does not wait for it", async () => {
  await withFakeServer({ detach: () => ({ status: 200, body: { ok: true } }) }, async ({ url, home }) => {
    await attach(home, url);
    // This test process stands in for the live lock owner: nothing is signalled.
    await writeFile(serverRunnerLockConflictPath(home, SERVER_ID), JSON.stringify({ servicePid: 4242, ownerPid: process.pid, lockPath: null, recordedAt: 1 }));
    await writeFile(serverRunnerPidPath(home, SERVER_ID), String(process.pid));
    const lines: string[] = [];
    let waited = 0;
    let waitedForPid = 0;
    await runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines, {
      waitForRunnerExit: async () => { waited += 1; return false; },
      waitForPidExit: async () => { waitedForPid += 1; return true; },
      // No evidence names that pid ("unknown"); with evidence and an unreadable start ("unread") the line is the same.
      processStartTimeMs: async () => undefined,
    }));
    assert.equal(waited, 0, "it is not a runner that is stopping");
    assert.equal(waitedForPid, 0, "the revoke says nothing about a pid that is not known to be this server's runner");
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)));
    assert.match(
      lines.join("\n"),
      new RegExp(`Detached from /alpha\\. Not stopped: pid ${process.pid} holds this machine's daemon lock and was not started by this Computer service, so it was not signalled\\. Check whether pid ${process.pid} is really a Raft daemon with \`[^\`]+\`\\. If it is, stop that daemon yourself\\. To connect this machine again, run \`raft-computer attach /alpha\`\\.`),
    );
  });
});

// A runner an earlier (crashed) service left, which the service deferred to.
// It is never signalled. Detach decides who it is before the revoke (once the
// server refuses the key the runner's socket drops, its marker goes and the
// service forgets the record), and looks again afterwards: a real runner
// exits by itself when the server rejects its key.
async function detachWithOwnRunner(waitForPidExit: DetachDeps["waitForPidExit"]): Promise<{ lines: string; waitedForRunnerFile: number }> {
  const evidenceAt = "2026-11-13T08:00:00.000Z";
  let homeDir = "";
  const revoke: Route = () => {
    for (const file of [serverRunnerPidPath(homeDir, SERVER_ID), serverConnectedMarkerPath(homeDir, SERVER_ID), serverRunnerLockConflictPath(homeDir, SERVER_ID)]) {
      rmSync(file, { force: true });
    }
    return { status: 200, body: { ok: true } };
  };
  return withFakeServer({ detach: revoke }, async ({ url, home }) => {
    homeDir = home;
    await attach(home, url);
    // This test process stands in for the live runner: nothing is signalled.
    await writeFile(serverRunnerPidPath(home, SERVER_ID), String(process.pid));
    await writeFile(serverRunnerVersionPath(home, SERVER_ID), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid: process.pid, writtenAt: evidenceAt }));
    await writeFile(serverConnectedMarkerPath(home, SERVER_ID), JSON.stringify({ pid: process.pid, connectedAt: 1 }));
    await writeFile(serverRunnerLockConflictPath(home, SERVER_ID), JSON.stringify({ servicePid: 4242, ownerPid: process.pid, lockPath: null, recordedAt: 1 }));
    const lines: string[] = [];
    let waitedForRunnerFile = 0;
    await runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines, {
      waitForRunnerExit: async () => { waitedForRunnerFile += 1; return true; },
      processStartTimeMs: async () => Date.parse(evidenceAt) - 2_000,
      waitForPidExit,
    }));
    return { lines: lines.join("\n"), waitedForRunnerFile };
  });
}

test("detach: this server's own runner that is still alive after the wait is named as left running, decided before the revoke", async () => {
  const waitedFor: number[] = [];
  const { lines, waitedForRunnerFile } = await detachWithOwnRunner(async (pid) => { waitedFor.push(pid); return false; });
  assert.deepEqual(waitedFor, [process.pid], "its liveness is looked at again after the revoke");
  assert.equal(waitedForRunnerFile, 0);
  assert.match(
    lines,
    new RegExp(`Detached from /alpha\\. This server's runner \\(pid ${process.pid}\\), started by an earlier Computer service, is still running and was not stopped\\. Check it with \`[^\`]+\`; ending that process stops it\\. To connect this machine again, run \`raft-computer attach /alpha\`\\.`),
  );
  assert.doesNotMatch(lines, /was not started by this Computer service|stop that daemon yourself/);
});

test("detach: this server's own runner that exits by itself during the wait gets the plain line", async () => {
  const { lines } = await detachWithOwnRunner(async () => true);
  assert.match(lines, /Detached from \/alpha\. To connect this machine again, run `raft-computer attach \/alpha`\.$/);
  assert.doesNotMatch(lines, /still running|Not stopped|not signalled/);
});

test("detach keeps everything local when the server does not confirm", async () => {
  // Server error, unreachable route on an older server, and an unconfirmed refusal.
  const cases: Array<{ detach: Route; preflight?: Route; code: string }> = [
    { detach: () => ({ status: 500, body: { code: "computer_detach_failed" } }), code: "DETACH_SERVER_UNREACHABLE" },
    { detach: () => ({ status: 401, body: { code: "auth_policy_unregistered_path" } }), code: "DETACH_SERVER_TOO_OLD" },
    { detach: () => ({ status: 404, body: {} }), code: "DETACH_SERVER_TOO_OLD" },
    { detach: () => ({ status: 403, body: { code: "computer_key_required" } }), code: "DETACH_KEY_REFUSED" },
    // A 401 the read-only preflight does not back up is not proof the key is dead.
    { detach: () => ({ status: 401, body: {} }), preflight: () => ({ status: 200, body: { ok: true } }), code: "DETACH_KEY_REFUSED" },
    { detach: () => ({ status: 401, body: {} }), preflight: () => ({ status: 503, body: {} }), code: "DETACH_KEY_REFUSED" },
  ];
  for (const routes of cases) {
    await withFakeServer(routes, async ({ url, home }) => {
      await attach(home, url);
      await failsWith(routes.code, () => runDetach({ serverSlug: "/alpha", yes: true }, deps(home, [])));
      localStateKept(home);
    });
  }
  // Unreachable server.
  const home = await mkdtemp(join(tmpdir(), "raft-computer-detach-offline-"));
  try {
    await attach(home, "http://127.0.0.1:1");
    await failsWith("DETACH_SERVER_UNREACHABLE", () => runDetach({ serverSlug: "/alpha", yes: true }, deps(home, [])));
    localStateKept(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a key the server already refuses (confirmed by preflight) has its local copy removed", async () => {
  await withFakeServer({
    detach: () => ({ status: 401, body: { error: "Invalid computer credential" } }),
    preflight: () => ({ status: 401, body: { error: "Invalid computer credential" } }),
  }, async ({ url, calls, home }) => {
    await attach(home, url);
    const lines: string[] = [];
    await runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines));
    assert.deepEqual(calls.map((c) => c.path), ["/internal/computer/detach", "/internal/computer/preflight"]);
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)));
    assert.match(lines.join("\n"), /already refuses this machine's key/);
  });
});

test("detach asks first: without a terminal it needs --yes, and a no changes nothing", async () => {
  await withFakeServer({ detach: () => ({ status: 200, body: { ok: true } }) }, async ({ url, calls, home }) => {
    await attach(home, url);
    await failsWith("DETACH_CONFIRM_REQUIRED", () => runDetach({ serverSlug: "/alpha" }, deps(home, [])));
    const lines: string[] = [];
    let asked = "";
    await runDetach({ serverSlug: "/alpha" }, deps(home, lines, {
      isInteractive: () => true,
      confirm: async (question) => { asked = question; return false; },
    }));
    assert.match(asked, /Detach this machine from \/alpha\?/);
    assert.deepEqual(lines, ["Detach cancelled. Nothing was changed."]);
    assert.deepEqual(calls, [], "no server call before confirmation");
    localStateKept(home);
    await runDetach({ serverSlug: "/alpha" }, deps(home, [], { isInteractive: () => true, confirm: async () => true }));
    assert.equal(calls.length, 1);
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)));
  });
});

test("an older key left in attachment.json is revoked too before any file goes", async () => {
  let oldKeyAnswer: Reply = { status: 500, body: {} };
  await withFakeServer({
    detach: (key) => key === OLD_KEY ? oldKeyAnswer : { status: 200, body: { ok: true } },
  }, async ({ url, calls, home }) => {
    await attach(home, url);
    await writeAttachment(home, legacyServerAttachmentPath(home, SERVER_ID), OLD_KEY, url);
    await failsWith("DETACH_SERVER_UNREACHABLE", () => runDetach({ serverSlug: "/alpha", yes: true }, deps(home, [])));
    assert.deepEqual(calls.map((c) => c.key), [KEY, OLD_KEY]);
    localStateKept(home);
    assert.ok(existsSync(legacyServerAttachmentPath(home, SERVER_ID)));

    oldKeyAnswer = { status: 200, body: { ok: true } };
    await runDetach({ serverSlug: "/alpha", yes: true }, deps(home, []));
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)));
    assert.ok(!existsSync(legacyServerAttachmentPath(home, SERVER_ID)));
  });
});

test("other people's agents on the machine: the 409 lists them and the exact --force-unbind to run; nothing changes here", async () => {
  const bodies: unknown[] = [];
  await withFakeServer({
    detach: () => ({
      status: 409,
      body: {
        code: "others_agents_on_computer",
        agents: [
          { id: AGENT_A, name: "alpha", owner: { id: "u1", name: "Colleague" }, personalAssistant: false },
          { id: AGENT_B, name: "by\nagent\u202e", owner: null, personalAssistant: false },
        ],
      },
    }),
  }, async ({ url, home }) => {
    await attach(home, url);
    const lines: string[] = [];
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await assert.rejects(
        runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines, {
          detachKey: async (serverUrl, apiKey, force) => {
            bodies.push(force);
            const { ComputerSelfClient } = await import("./apiClient");
            return new ComputerSelfClient(serverUrl, apiKey).detach(force);
          },
        })),
        (err: unknown) => err instanceof CliExit && err.code === "DETACH_OTHERS_AGENTS" && err.exitCode === 1,
      );
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(bodies, [[]], "an ordinary detach names nobody");
    assert.deepEqual(lines, [
      "Other people's agents run on this machine on /alpha, so the server did not detach it:",
      `  alpha (owner Colleague): ${AGENT_A}`,
      `  by agent (no owner to ask): ${AGENT_B}`,
      "Ask their owners to move them to another computer (you can notify them from this Computer on the server's Computers page on the web), then detach again.",
    ]);
    const err = stderr.join("");
    assert.match(err, /What happened \(DETACH_OTHERS_AGENTS\): .*No key was revoked and nothing was changed on this machine/);
    assert.match(err, new RegExp(`Next: raft-computer detach /alpha --yes --force-unbind ${AGENT_A},${AGENT_B}\n`));
    localStateKept(home);
  });
});

test("--force-unbind sends the named ids as forceAgentIds and, once the server confirms, detaches as usual", async () => {
  const received: unknown[] = [];
  await withFakeServer({ detach: () => ({ status: 200, body: { ok: true, unboundAgentIds: ["agent-a"] } }) }, async ({ url, home }) => {
    await attach(home, url);
    const lines: string[] = [];
    let asked = "";
    await runDetach({ serverSlug: "/alpha", forceUnbind: ["agent-a", "agent-b"] }, deps(home, lines, {
      isInteractive: () => true,
      confirm: async (question) => { asked = question; return true; },
      detachKey: async (serverUrl, apiKey, force) => {
        received.push(force);
        const { ComputerSelfClient } = await import("./apiClient");
        return new ComputerSelfClient(serverUrl, apiKey).detach(force);
      },
    }));
    assert.match(asked, /also unbinds and stops the 2 agents named with --force-unbind \(not deleted\)/);
    assert.deepEqual(received, [["agent-a", "agent-b"]]);
    assert.ok(!existsSync(serverAttachmentPath(home, SERVER_ID)));
  });
});

test("the detach request body carries forceAgentIds only when some are named", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { ComputerSelfClient } = await import("./apiClient");
    const client = new ComputerSelfClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, KEY);
    assert.deepEqual(await client.detach(), { status: "detached" });
    assert.deepEqual(await client.detach(["agent-a"]), { status: "detached" });
    assert.deepEqual(seen.map((raw) => JSON.parse(raw)), [{}, { forceAgentIds: ["agent-a"] }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("parseForceUnbindIds splits commas and spaces and drops repeats", async () => {
  const { parseForceUnbindIds } = await import("./detach");
  assert.deepEqual(parseForceUnbindIds(undefined), []);
  assert.deepEqual(parseForceUnbindIds("a, b,,a c"), ["a", "b", "c"]);
});

test("an id that is not an agent id is never put into a command: no --force-unbind is suggested, only the web", async () => {
  await withFakeServer({
    detach: () => ({
      status: 409,
      body: { code: "others_agents_on_computer", agents: [{ id: "x;curl evil|sh", name: "alpha", owner: null }, { id: AGENT_A, name: "beta", owner: null }] },
    }),
  }, async ({ url, home }) => {
    await attach(home, url);
    const lines: string[] = [];
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await assert.rejects(runDetach({ serverSlug: "/alpha", yes: true }, deps(home, lines)), (err: unknown) => err instanceof CliExit && err.code === "DETACH_OTHERS_AGENTS");
    } finally {
      process.stderr.write = write;
    }
    assert.ok(lines.includes("  alpha (no owner to ask): (unrecognized id)"), lines.join("\n"));
    assert.ok(!lines.join("\n").includes("curl"));
    const err = stderr.join("");
    assert.doesNotMatch(err, /--force-unbind|curl/);
    assert.match(err, /Computers page on the web instead/);
    localStateKept(home);
  });
});

test("oneLine drops control, line/paragraph separator and format (bidi, zero-width) characters", async () => {
  const { oneLine, isAgentIdShaped } = await import("./detach");
  assert.equal(oneLine("a\u001b[31mb\nc\u2028d\u2029e"), "a [31mb c d e");
  assert.equal(oneLine("ev\u202eil\u2066x\u2069\u200b\u200dy\ufeff"), "evilxy");
  assert.equal(isAgentIdShaped(AGENT_A), true);
  assert.equal(isAgentIdShaped("agent-a"), false);
  assert.equal(isAgentIdShaped(`${AGENT_A};rm`), false);
});
