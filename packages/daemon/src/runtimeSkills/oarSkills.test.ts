import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InventoryOptions, InventoryResult, SkillEntry } from "@botiverse/oar";
import type { SkillInfo } from "@botiverse/raft-shared";

import { OPENCODE_EMPTY_CONFIG_DIR } from "../drivers/opencode";
import { OAR_SKILLS_TIMEOUT_MS, OarSkillCatalog, defaultLaunchEnv, classifyOarSkill, mapOarSkills, type OarSkillsOutcome, type OarSkillsRequest, type OarSkillsSourceResolver, type RuntimeSkillLists } from "./oarSkills";

const WORKSPACE = "/home/alice/.raft/agents/agent-1";
const REQUEST: OarSkillsRequest = { agentId: "agent-1", runtime: "codex", workspaceDir: WORKSPACE, homeDir: "/home/alice" };

function ok(items: SkillEntry[], partial = false): InventoryResult<SkillEntry> {
  return { kind: "ok", scope: { kind: "workspace", cwd: WORKSPACE }, observedAt: "2026-11-16T00:00:00Z", view: "discovered", items, partial };
}

function skill(name: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return { name, displayName: name, description: "", userInvocable: false, ...extra };
}

/** A resolver whose reader returns `results` in turn and records each call. */
/** The lists of an ok outcome; fails the test otherwise. */
function listsOf(outcome: OarSkillsOutcome | null): RuntimeSkillLists {
  assert.equal(outcome?.kind, "ok", JSON.stringify(outcome));
  return (outcome as Extract<OarSkillsOutcome, { kind: "ok" }>).lists;
}

function fakeSource(results: Array<InventoryResult<SkillEntry> | Promise<InventoryResult<SkillEntry>> | Error>) {
  const calls: Array<{ runtime: string; options: InventoryOptions | undefined }> = [];
  const resolveSource: OarSkillsSourceResolver = async (runtime) => ({
    installation: { kind: "available", via: "executable", command: runtime },
    read: async (_installation, options) => {
      calls.push({ runtime, options });
      const next = results.shift();
      if (!next) throw new Error("no more results");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { calls, resolveSource };
}

test("Codex entries group by OAR scope: system is built-in, repo is workspace, user is global", () => {
  const lists = mapOarSkills([
    { name: "imagegen", description: "Make images", path: "/home/alice/.codex/skills/.system/imagegen/SKILL.md", source: "system", scope: "builtin" },
    { name: "review", description: "Review a diff", path: "/home/alice/.codex/skills/review/SKILL.md", source: "user", scope: "user" },
    { name: "local", description: "Repo skill", path: `${WORKSPACE}/.agents/skills/local/SKILL.md`, source: "repo", scope: "project" },
    { name: "off", path: "/home/alice/.codex/skills/off/SKILL.md", source: "user", enabled: false },
    { name: "review", path: "/elsewhere/review/SKILL.md", source: "user" },
  ], REQUEST);
  assert.deepEqual(lists.builtin, [
    { name: "imagegen", displayName: "imagegen", description: "Make images", userInvocable: false, sourcePath: "~/.codex/skills/.system" },
  ]);
  assert.deepEqual(lists.global, [
    { name: "review", displayName: "review", description: "Review a diff", userInvocable: false, sourcePath: "~/.codex/skills" },
  ], "disabled entries are dropped; the first of a name wins; no `userInvocable` from OAR: unknown, no /name badge");
  assert.deepEqual(lists.workspace.map((entry) => [entry.name, entry.sourcePath]), [["local", "~/.raft/agents/agent-1/.agents/skills"]]);
});

test("Claude entries show as OAR gives them, nothing added from Raft's own folder reading; `userInvocable` only where OAR says true (OAR 0.120)", () => {
  const lists = mapOarSkills([
    { name: "simplify", source: "built-in", scope: "builtin", userInvocable: true },
    { name: "pdf", description: "Fill PDFs", source: "userSettings", scope: "user", userInvocable: true },
    { name: "deploy", source: "projectSettings", scope: "project", userInvocable: false },
    { name: "from-plugin", source: "plugin", scope: "other" },
  ], REQUEST);
  assert.deepEqual(lists.builtin, [{ name: "simplify", displayName: "simplify", description: "", userInvocable: true }]);
  assert.deepEqual(lists.global, [
    { name: "pdf", displayName: "pdf", description: "Fill PDFs", userInvocable: true },
    { name: "from-plugin", displayName: "from-plugin", description: "", userInvocable: false },
  ], "absent is unknown: no /name badge");
  assert.deepEqual(lists.workspace, [{ name: "deploy", displayName: "deploy", description: "", userInvocable: false }], "false: Claude doesn't list it as a command");
});

test("an entry with no scope goes by its path: inside the workspace is a workspace skill; no path, or one outside, global", () => {
  assert.equal(classifyOarSkill({ name: "deploy" }, WORKSPACE), "global");
  assert.equal(classifyOarSkill({ name: "w", path: `${WORKSPACE}/.claude/skills/w/SKILL.md` }, WORKSPACE), "workspace");
  assert.equal(classifyOarSkill({ name: "x", path: `${WORKSPACE}-sibling/x/SKILL.md` }, WORKSPACE), "global");
});

test("a runtime OAR does not cover is null; no installation, unsupported/unavailable results and throws are unavailable with their reason, never cached", async () => {
  const { calls, resolveSource } = fakeSource([
    { kind: "unsupported", code: "native_query_unavailable", reason: "old codex" },
    { kind: "unavailable", code: "timeout", reason: "slow" },
    new Error("spawn failed"),
  ]);
  const catalog = new OarSkillCatalog({ resolveSource });
  assert.equal(await catalog.list({ ...REQUEST, runtime: "devin" }), null);
  assert.equal(calls.length, 0, "a runtime OAR skills does not cover is never read");
  assert.deepEqual(await catalog.list(REQUEST), { kind: "unavailable", reason: "unsupported:native_query_unavailable" });
  assert.deepEqual(await catalog.list(REQUEST), { kind: "unavailable", reason: "unavailable:timeout" });
  assert.deepEqual(await catalog.list(REQUEST), { kind: "unavailable", reason: "threw:Error" });
  assert.equal(calls.length, 3, "failures are not cached");

  const none = new OarSkillCatalog({ resolveSource: async () => null });
  assert.deepEqual(await none.list(REQUEST), { kind: "unavailable", reason: "no_installation" });
});

test("the reader gets the workspace as cwd, the env overlay and a timeout; a hung read hits our deadline", async () => {
  const { calls, resolveSource } = fakeSource([new Promise(() => {})]);
  const catalog = new OarSkillCatalog({ resolveSource, timeoutMs: 10 });
  assert.deepEqual(await catalog.list({ ...REQUEST, env: { CODEX_HOME: "/custom" } }), { kind: "unavailable", reason: "deadline" });
  assert.deepEqual(calls[0]?.options, { cwd: WORKSPACE, timeoutMs: 10, env: { CODEX_HOME: "/custom" } });
});

test("concurrent callers share one read, and a success is cached until the TTL ends", async () => {
  let release!: (result: InventoryResult<SkillEntry>) => void;
  const first = new Promise<InventoryResult<SkillEntry>>((resolve) => { release = resolve; });
  const { calls, resolveSource } = fakeSource([first, ok([{ name: "fresh", source: "user" }])]);
  let now = 1_000;
  const catalog = new OarSkillCatalog({ resolveSource, ttlMs: 60_000, now: () => now });

  const a = catalog.list(REQUEST);
  const b = catalog.list(REQUEST);
  await new Promise((resolve) => setImmediate(resolve));
  release(ok([{ name: "cached", source: "user" }]));
  const [listA, listB] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.deepEqual(listA?.kind === "ok" && listA.lists.global.map((entry) => entry.name), ["cached"]);
  assert.deepEqual(listB, listA);

  now += 59_000;
  assert.deepEqual(listsOf(await catalog.list(REQUEST)).global.map((entry) => entry.name), ["cached"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(listsOf(await catalog.list({ ...REQUEST, agentId: "agent-2" })).global.map((entry) => entry.name), ["fresh"], "keyed per agent");
  assert.equal(calls.length, 2);
});

test("an expired entry is read again", async () => {
  const { calls, resolveSource } = fakeSource([ok([{ name: "one" }]), ok([{ name: "two" }])]);
  let now = 0;
  const catalog = new OarSkillCatalog({ resolveSource, ttlMs: 100, now: () => now });
  assert.deepEqual(listsOf(await catalog.list(REQUEST)).global.map((entry) => entry.name), ["one"]);
  now = 101;
  assert.deepEqual(listsOf(await catalog.list(REQUEST)).global.map((entry) => entry.name), ["two"]);
  assert.equal(calls.length, 2);
});

test("real Claude entries from OAR 0.112: built-in, syncedSkills (other), projectSettings", () => {
  const lists = mapOarSkills([
    { name: "update-config", source: "built-in", scope: "builtin" },
    { name: "docs", source: "syncedSkills", scope: "other" },
    { name: "release", source: "projectSettings", scope: "project" },
  ], REQUEST);
  assert.deepEqual(lists.builtin.map((entry) => entry.name), ["update-config"]);
  assert.deepEqual(lists.global.map((entry) => entry.name), ["docs"]);
  assert.deepEqual(lists.workspace.map((entry) => entry.name), ["release"]);
});

test("only what OAR reports shows; a disabled entry stays hidden", () => {
  const lists = mapOarSkills([
    { name: "update-config", source: "built-in", scope: "builtin" },
    { name: "off", source: "user", scope: "user", enabled: false },
  ], REQUEST);
  assert.deepEqual(lists, { builtin: [{ name: "update-config", displayName: "update-config", description: "", userInvocable: false }], global: [], workspace: [] });
});

test("a changed env is a different cache entry", async () => {
  const { calls, resolveSource } = fakeSource([ok([{ name: "a" }]), ok([{ name: "b" }])]);
  const catalog = new OarSkillCatalog({ resolveSource, ttlMs: 60_000 });
  await catalog.list({ ...REQUEST, env: { CODEX_HOME: "/one" } });
  assert.deepEqual(listsOf(await catalog.list({ ...REQUEST, env: { CODEX_HOME: "/two" } })).global.map((entry) => entry.name), ["b"]);
  assert.equal(calls.length, 2);
});

test("a workspace-relative name starting with .. is still inside", () => {
  assert.equal(classifyOarSkill({ name: "x", path: `${WORKSPACE}/..cache/x/SKILL.md` }, WORKSPACE), "workspace");
  assert.equal(classifyOarSkill({ name: "y", path: `${WORKSPACE}/../y/SKILL.md` }, WORKSPACE), "global");
});

test("scope wins over path and source: an OpenCode project skill above the workspace, a managed Codex skill, a source without scope", () => {
  assert.equal(classifyOarSkill({ name: "p", path: "/home/alice/.opencode/skills/p/SKILL.md", scope: "project" }, WORKSPACE), "workspace");
  assert.equal(classifyOarSkill({ name: "m", path: "/etc/codex/skills/m/SKILL.md", scope: "managed" }, WORKSPACE), "global");
  assert.equal(classifyOarSkill({ name: "u", path: `${WORKSPACE}/.claude/skills/u/SKILL.md`, scope: "user" }, WORKSPACE), "global");
  assert.equal(classifyOarSkill({ name: "s", source: "system" }, WORKSPACE), "global", "only scope means built-in");
  assert.equal(classifyOarSkill({ name: "o", path: `${WORKSPACE}/x/o/SKILL.md`, scope: "other" }, WORKSPACE), "workspace");
});

test("Kimi is read through OAR", async () => {
  const { calls, resolveSource } = fakeSource([ok([{ name: "k", scope: "builtin" }])]);
  const catalog = new OarSkillCatalog({ resolveSource });
  assert.deepEqual(listsOf(await catalog.list({ ...REQUEST, runtime: "kimi" })).builtin?.map((entry) => entry.name), ["k"]);
  assert.deepEqual(calls.map((call) => call.runtime), ["kimi"]);
});

test("Antigravity is read through OAR in its launch's environment: no SSH variables (agy's other sign-in), the agent's env vars kept, OAR's list as it is", async () => {
  const { calls, resolveSource } = fakeSource([ok([
    { name: "frontend-design", scope: "user", path: "/home/u/.gemini/config/skills/frontend-design/SKILL.md" },
    { name: "review", scope: "builtin" },
  ])]);
  const catalog = new OarSkillCatalog({ resolveSource });
  const lists = listsOf(await catalog.list({ ...REQUEST, runtime: "antigravity", env: { FOO: "bar" } }));
  assert.deepEqual(calls.map((call) => call.runtime), ["antigravity"]);
  assert.deepEqual(calls[0]?.options, {
    cwd: WORKSPACE,
    timeoutMs: OAR_SKILLS_TIMEOUT_MS,
    env: { FOO: "bar", NO_COLOR: "1", SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null },
  });
  assert.deepEqual(lists.builtin?.map((entry) => entry.name), ["review"]);
  assert.deepEqual(lists.global.map((entry) => entry.name), ["frontend-design"]);
  assert.deepEqual(lists.workspace, []);
});

test("OpenCode 2.x is read with the launch's config isolation over the agent's env; 1.x (debug skill, no server) in the agent's own env", async () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "raft-oarskills-"));
  try {
    const reads: Array<{ version: string | undefined; options: unknown }> = [];
    let version: string | undefined = "opencode v2.3.0";
    const resolveSource: OarSkillsSourceResolver = async () => ({
      installation: { kind: "available", via: "executable", command: "opencode", version },
      read: async (_installation, options) => {
        reads.push({ version, options });
        return ok([{ name: "o", scope: "user" }]);
      },
    });
    const catalog = new OarSkillCatalog({ resolveSource });
    const request = { ...REQUEST, runtime: "opencode", slockHome, env: {
      OPENCODE_CONFIG_DIR: "/agent/set/this",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["file:///w/x.js"], provider: { p: {} } }),
      FOO: "bar",
    } };
    assert.deepEqual(listsOf(await catalog.list(request)).global.map((entry) => entry.name), ["o"]);
    const emptyDir = path.join(slockHome, OPENCODE_EMPTY_CONFIG_DIR);
    assert.deepEqual(reads[0]?.options, {
      cwd: WORKSPACE,
      timeoutMs: OAR_SKILLS_TIMEOUT_MS,
      env: {
        FOO: "bar",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_DIR: emptyDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { p: {} } }),
      },
    }, "isolation wins over the agent's own OPENCODE_CONFIG_DIR, and its plugin list is dropped, as at launch");
    assert.equal(existsSync(emptyDir), true);

    // 1.x (or a version not read): OAR runs `opencode debug skill`, no server, in the agent's own env.
    version = "1.14.0";
    assert.equal((await catalog.list({ ...request, agentId: "agent-1x" }))?.kind, "ok");
    assert.equal(reads.length, 2, "1.x is read through OAR too");
    assert.deepEqual((reads[1]?.options as { env?: unknown }).env, request.env);
    version = undefined;
    assert.equal((await catalog.list({ ...request, agentId: "agent-unknown" }))?.kind, "ok");
    assert.equal(reads.length, 3);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("a path that is not an absolute file path (a skill:// URI) is neither a source folder nor a placement", () => {
  const lists = mapOarSkills([
    { name: "builtin-uri", path: "skill://opencode/SKILL.md", scope: "builtin" },
    { name: "plugin-uri", path: "skill://report/SKILL.md" },
  ], REQUEST);
  assert.deepEqual(lists.builtin, [{ name: "builtin-uri", displayName: "builtin-uri", description: "", userInvocable: false }]);
  assert.deepEqual(lists.global.map((entry) => [entry.name, entry.sourcePath]), [["plugin-uri", undefined]]);
});

test("the OpenCode read always sets OPENCODE_CONFIG_CONTENT, so one the daemon inherited cannot bring plugins", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "raft-oarskills-"));
  try {
    const installation = { kind: "available", via: "executable", command: "opencode", version: "opencode v2.3.0" } as const;
    assert.equal(defaultLaunchEnv("opencode", installation, slockHome, undefined)?.OPENCODE_CONFIG_CONTENT, "{}");
    assert.deepEqual(defaultLaunchEnv("claude", installation, slockHome, undefined), {});
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("the Cursor read gets a Cursor session child's environment (the agent's HOME and env vars over the kept daemon ones) without the API key", () => {
  const installation = { kind: "available", via: "bundled" } as const;
  const env = defaultLaunchEnv("cursor", installation, undefined, { HOME: "/agents/a1/home", CURSOR_API_KEY: "k", EXTRA: "1" });
  assert.equal(env?.HOME, "/agents/a1/home");
  assert.equal(env?.EXTRA, "1");
  assert.equal(env?.SHELL, "/bin/sh");
  assert.equal(env && "CURSOR_API_KEY" in env, false, "the read needs no key; it never enters its child processes");
});
