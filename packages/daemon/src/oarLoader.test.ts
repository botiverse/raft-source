import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Runtime } from "@botiverse/oar";

import { loadOarRuntime, loadOarSessionRuntime, pinIsolated } from "./oarLoader";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    // Test support (src/testing/) is never in the daemon bundle: it may load OAR's
    // testing entry, as the OAR host harness does (#13240). That nothing shipped
    // imports it is pinned by check-daemon-runtime-boundaries (test-support-import).
    if (statSync(full).isDirectory()) return full === path.join(SRC, "testing") ? [] : sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/**
 * OAR subpaths a daemon module may import statically: synchronous helpers that
 * load no runtime and no SDK (Node built-ins only). The Codex installation
 * candidates (OAR 0.101) feed the synchronous Codex discovery (drivers/codex.ts).
 */
const STATIC_OAR_SUBPATHS = new Set(["@botiverse/oar/runtimes/codex/installation-candidates"]);

test("source guard: the daemon loads OAR one runtime at a time, never its root entry", () => {
  // OAR's root entry loads every runtime it supports (~49 MB of heap); a
  // runtime entry is 1-2.4 MB. Values go through loadOarRuntime(); types are free.
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(SRC, file);
    for (const [statement, typeOnly, specifier] of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(@botiverse\/oar[^"]*)";/gms)) {
      if (!typeOnly && !STATIC_OAR_SUBPATHS.has(specifier!)) offenders.push(`${rel}: static ${statement.split("\n")[0]}`);
    }
    for (const [call] of source.matchAll(/import\("@botiverse\/oar"\)/g)) offenders.push(`${rel}: root ${call}`);
    if (rel !== "oarLoader.ts") {
      for (const [call] of source.matchAll(/import\("@botiverse\/oar\/[^"]+"\)/g)) offenders.push(`${rel}: outside oarLoader ${call}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("each account-usage provider and opencode load their own OAR runtime, once", async () => {
  for (const [id, name] of [["claude", "claude"], ["codex", "codex"], ["kimi", "kimi"], ["grok", "grok"], ["opencode", "opencode"], ["qwen", "qwen"], ["qoder", "qoder"], ["codebuddy", "codebuddy"]] as const) {
    const [first, second] = await Promise.all([loadOarRuntime(id), loadOarRuntime(id)]);
    assert.equal(first, second);
    assert.equal(first.id, name);
  }
  assert.equal(typeof (await loadOarRuntime("kimi")).accountUsage, "function");
  assert.equal(typeof (await loadOarRuntime("opencode")).listModels, "function");
});

test("agent sessions open one process per session; usage and model reads keep OAR's own runtime", async () => {
  // The runtimes the OAR host opens agent sessions on (OarLaunch.runtimeId).
  for (const id of ["antigravity", "grok", "qwen", "qoder", "codebuddy"] as const) {
    const [first, second] = await Promise.all([loadOarSessionRuntime(id), loadOarSessionRuntime(id)]);
    assert.equal(first, second);
    assert.equal(first.id, id);
    assert.equal(first.execution, "process", id);
    assert.equal(first.placement, "isolated", id);
    const plain = await loadOarRuntime(id);
    assert.notEqual(plain, first, id);
    assert.equal(plain.placement, "auto", id);
  }
});

test("Cursor runs in OAR's subprocess mode on the SDK the daemon ships, one child per session; loading it imports no SDK", async () => {
  const { cursorSdkModule } = await import("./oarLoader");
  assert.match(cursorSdkModule(), /^file:.*@cursor\/sdk\//u, "a daemon dependency, resolved to a file URL for OAR's child");
  const cursor = await loadOarRuntime("cursor");
  assert.equal(cursor.id, "cursor");
  assert.equal(cursor.execution, "process");
  const session = await loadOarSessionRuntime("cursor");
  assert.equal(session.placement, "isolated");
  assert.equal(cursor.refusedSessionOptions?.env, undefined, "the session's env is taken");
});

test("pinIsolated leaves in-process runtimes alone (they reject an explicit placement at open)", async () => {
  // The root entry is fine in a test: it lists every builtin, including ones the daemon never loads.
  const builtins = (Object.values(await import("@botiverse/oar")) as unknown[]).filter(
    (value): value is Runtime => typeof value === "object" && value !== null && typeof (value as Runtime).withPlacement === "function",
  );
  assert.ok(builtins.some((runtime) => runtime.execution === "in_process"), "OAR still has an in-process builtin (Cursor/Pi)");
  for (const runtime of builtins) {
    const pinned = pinIsolated(runtime);
    if (runtime.execution === "process") assert.equal(pinned.placement, "isolated", runtime.id);
    else assert.equal(pinned, runtime, runtime.id);
  }
});

test("the OAR host's modules load as an antigravity, codex, grok, qwen, qoder or codebuddy launch reaches them, and Grok's, CodeBuddy's and OpenCode's sign-in modules too (what the SEA release smoke runs)", async () => {
  const { verifyBundledOarHost } = await import("./oarLoader");
  const started = Date.now();
  await verifyBundledOarHost();
  assert.ok(Date.now() - started < 10_000, "a missing executable fails at the spawn, not at a protocol deadline");
});

test("OAR 0.99 Grok's sign-in reads a missing grok as unknown, starting nothing (the smoke's Grok sign-in check)", async () => {
  const grok = await loadOarRuntime("grok");
  assert.equal(typeof grok.login, "function");
  assert.equal(typeof grok.logout, "function");
  const status = await grok.authStatus!({ kind: "available", via: "executable", command: path.join(os.tmpdir(), "raft-oar-test-no-such-grok") }, { timeoutMs: 5_000 });
  assert.equal(status.kind, "unknown");
});

test("CodeBuddy's sign-in reads a missing codebuddy as unknown, starting nothing (the smoke's CodeBuddy sign-in check)", async () => {
  const codebuddy = await loadOarRuntime("codebuddy");
  assert.equal(typeof codebuddy.login, "function");
  assert.equal(typeof codebuddy.logout, "function");
  assert.equal(typeof codebuddy.listModels, "function");
  const status = await codebuddy.authStatus!({ kind: "available", via: "executable", command: path.join(os.tmpdir(), "raft-oar-test-no-such-codebuddy") }, { timeoutMs: 5_000 });
  assert.equal(status.kind, "unknown");
});

test("OAR 0.100 OpenCode's provider sign-in on a missing opencode fails at the spawn of opencode serve with OAR's own error (the smoke's OpenCode check)", async () => {
  const { loadOarOpencodeProviderAuth } = await import("./oarLoader");
  const started = Date.now();
  await assert.rejects(
    loadOarOpencodeProviderAuth(
      // A version given: no `--version` run, so the facade module itself loads and starts the server.
      { kind: "available", via: "executable", command: path.join(os.tmpdir(), "raft-oar-test-no-such-opencode"), version: "opencode v2.2.7" },
      { timeoutMs: 5_000, idleMs: 0, loopback: "refuse" },
    ),
    (error: unknown) => (error as { name?: string; kind?: string }).name === "OpencodeProviderAuthError" && (error as { kind?: string }).kind === "startup_failed",
  );
  assert.ok(Date.now() - started < 5_000, "a missing executable fails at the spawn, not at the startup deadline");
});

test("the release smoke counts only a failure at the process as the session path reaching it", async () => {
  const { isMissingExecutableFailure } = await import("./oarLoader");
  const enoent = Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" });
  const acpExited = Object.assign(new Error("ACP process exited"), { name: "AcpError", kind: "process_exited" });
  const acpTimeout = Object.assign(new Error("ACP request initialize timed out"), { name: "AcpError", kind: "timeout" });
  assert.equal(isMissingExecutableFailure(enoent, "linux"), true);
  assert.equal(isMissingExecutableFailure(enoent, "win32"), true);
  // OAR 0.76.2 Qoder: `--version` runs first and wraps the failed spawn in its process failure.
  const versionEnoent = new Error("Failed to run /tmp/x --version: exit code unavailable; signal none; ENOENT: spawn /tmp/x ENOENT", {
    cause: { exitCode: null, signal: null, stderr: "", error: { code: "ENOENT", message: "spawn /tmp/x ENOENT" } },
  });
  assert.equal(isMissingExecutableFailure(versionEnoent, "linux"), true);
  const versionTimeout = new Error("Failed to run /tmp/x --version: exit code unavailable; signal none; timeout after 5000 ms", {
    cause: { exitCode: null, signal: null, stderr: "", timeoutMs: 5000 },
  });
  assert.equal(isMissingExecutableFailure(versionTimeout, "linux"), false);
  // Windows launches ACP runtimes through a shim: the missing executable ends the launched process.
  assert.equal(isMissingExecutableFailure(acpExited, "win32"), true);
  assert.equal(isMissingExecutableFailure(acpExited, "linux"), false);
  assert.equal(isMissingExecutableFailure(acpTimeout, "linux"), false);
  // Windows runs no OAR sessions: only a module missing from the bundle fails the smoke there.
  assert.equal(isMissingExecutableFailure(acpTimeout, "win32"), true);
  assert.equal(isMissingExecutableFailure(new Error("Cannot find module './session.js'"), "win32"), false);
  assert.equal(isMissingExecutableFailure(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }), "win32"), false);
});
