import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { defineRuntime, type AccountUsageReadOptions, type AvailableInstallation, type Runtime } from "@botiverse/oar";
import { runtimeAccountUsageSnapshotSchema, type RuntimeAccountUsageAccountHome } from "@botiverse/raft-shared";

import type { CredentialLocationContext } from "../credentialSource";
import { planRuntimeAccountUsageFolders, RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX } from "./accountFolders";
import { createRuntimeAccountUsageCollector } from "./collector";

const SLOT = "/home/agent/.slock";
const CTX: CredentialLocationContext = { env: { HOME: "/home/agent" }, homeDir: "/home/agent", platform: "linux", cwd: "/work" };

function keyOf(provider: string, slot: string): string {
  return createHash("sha256").update(`${provider}\u0000${slot}`).digest("hex");
}

/** A Codex runtime whose usage depends on CODEX_HOME / HOME in the read's env; records every env it was given. */
function folderRuntime(usedByFolder: Record<string, number | "throw">) {
  const envs: Array<AccountUsageReadOptions["env"] | undefined> = [];
  const runtime = defineRuntime({
    id: "folders",
    session: (() => {
      throw new Error("session must not be started by an account-usage read");
    }) as unknown as Runtime["session"],
    installation: async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/codex", version: "0.130.0" }),
    accountUsage: async (_installation: AvailableInstallation, options?: AccountUsageReadOptions) => {
      envs.push(options?.env);
      const folder = options?.env?.CODEX_HOME ?? (options?.env?.HOME ? `${options.env.HOME}/.codex` : "default");
      const used = usedByFolder[folder ?? "default"];
      if (used === "throw" || used === undefined) throw new Error(`no usage for ${folder}`);
      return { kind: "available", rateLimited: false, windows: [{ label: "Current session", usedRatio: used }] } as const;
    },
  });
  return { runtime, envs };
}

function collector(runtime: Runtime) {
  return createRuntimeAccountUsageCollector({
    localAccountSlot: SLOT,
    collectorVersion: "test",
    now: () => Date.parse("2026-11-18T09:00:00.000Z"),
    oar: { runtime, timeoutMs: 1234 },
    folderContext: () => CTX,
  });
}

test("without accountHomes the read is the default account's only, with no env, as before", async () => {
  const { runtime, envs } = folderRuntime({ default: 0.1 });
  const collect = collector(runtime);
  const plain = await collect("codex");
  assert.deepEqual(envs, [undefined]);
  assert.deepEqual(plain.accounts.map((account) => account.accountKey), [keyOf("codex", SLOT)]);
  assert.equal(plain.accounts[0]!.agentIds, undefined);
  // A provider without folders ignores them.
  const { runtime: kimiLike, envs: kimiEnvs } = folderRuntime({ default: 0.1 });
  await collector(kimiLike)("grok", { accountHomes: [{ agentIds: ["a1"], env: { HOME: "/srv/a" } }] });
  assert.deepEqual(kimiEnvs, [undefined]);
});

test("two agent folders: the default account plus one account per folder, each tagged with its agents", async () => {
  const { runtime, envs } = folderRuntime({ default: 0.1, "/srv/a": 0.5, "/srv/b/.codex": 0.9 });
  const seen: Array<{ folders: number; dropped: number }> = [];
  const snapshot = await collector(runtime)("codex", {
    accountHomes: [
      { agentIds: ["a1", "a2"], env: { CODEX_HOME: "/srv/a" } },
      { agentIds: ["b1"], env: { HOME: "/srv/b" } },
    ],
    onFolders: (counts) => seen.push(counts),
  });
  assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(snapshot).success, true);
  assert.deepEqual(snapshot.accounts.map((account) => [account.accountKey, account.agentIds ?? null, account.windows[0]?.usedRatio]), [
    [keyOf("codex", SLOT), null, 0.1],
    [keyOf("codex", "/srv/a"), ["a1", "a2"], 0.5],
    [keyOf("codex", "/srv/b/.codex"), ["b1"], 0.9],
  ]);
  assert.deepEqual(seen, [{ folders: 2, dropped: 0 }]);
  // The default read keeps no env; each folder reads under its agents' own env only.
  assert.equal(envs.length, 3);
  assert.ok(envs.includes(undefined));
  assert.ok(envs.some((env) => JSON.stringify(env) === JSON.stringify({ CODEX_HOME: "/srv/a" })));
  assert.ok(envs.some((env) => JSON.stringify(env) === JSON.stringify({ HOME: "/srv/b" })));
});

test("a folder that is the daemon's own default adds nothing; two spellings of one folder are one account", async () => {
  const { runtime, envs } = folderRuntime({ default: 0.1, "/srv/a": 0.5 });
  const snapshot = await collector(runtime)("codex", {
    accountHomes: [
      { agentIds: ["d1"], env: { CODEX_HOME: "/home/agent/.codex" } },
      { agentIds: ["d2"], env: { HOME: "/home/agent/" } },
      { agentIds: ["a1"], env: { CODEX_HOME: "/srv/a" } },
      { agentIds: ["a2"], env: { CODEX_HOME: "/srv/x/../a/" } },
    ],
  });
  assert.equal(envs.length, 2, "the default read and /srv/a once");
  assert.deepEqual(snapshot.accounts.map((account) => account.agentIds ?? null), [null, ["a1", "a2"]]);
});

test("a relative folder resolves against the daemon's cwd, as the runtime resolves it", () => {
  const plan = planRuntimeAccountUsageFolders("claude", [{ agentIds: ["c1"], env: { CLAUDE_CONFIG_DIR: "claude-c1" } }, { agentIds: ["h1"], env: { HOME: "/srv/h" } }], CTX);
  assert.deepEqual(plan.folders.map((folder) => folder.folder), ["/srv/h/.claude", "/work/claude-c1"]);
});

test("one folder failing is that folder's error account only", async () => {
  const { runtime } = folderRuntime({ default: 0.1, "/srv/a": "throw", "/srv/b": 0.3 });
  const snapshot = await collector(runtime)("codex", {
    accountHomes: [
      { agentIds: ["a1"], env: { CODEX_HOME: "/srv/a" } },
      { agentIds: ["b1"], env: { CODEX_HOME: "/srv/b" } },
    ],
  });
  assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(snapshot).success, true);
  assert.deepEqual(snapshot.accounts.map((account) => [account.agentIds ?? null, account.health, account.windows.length]), [
    [null, "ok", 1],
    [["a1"], "error", 0],
    [["b1"], "ok", 1],
  ]);
});

test("past seven folders, the rest (by folder) are left unread and counted", async () => {
  const folders = Array.from({ length: 10 }, (_, index) => `/srv/f${index}`);
  const { runtime, envs } = folderRuntime(Object.fromEntries([["default", 0.1], ...folders.map((folder) => [folder, 0.2])]));
  const seen: Array<{ folders: number; dropped: number }> = [];
  const snapshot = await collector(runtime)("codex", {
    accountHomes: folders.slice().reverse().map((folder, index) => ({ agentIds: [`agent-${index}`], env: { CODEX_HOME: folder } })),
    onFolders: (counts) => seen.push(counts),
  });
  assert.equal(RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX, 7);
  assert.equal(snapshot.accounts.length, 8);
  assert.equal(envs.length, 8);
  assert.deepEqual(seen, [{ folders: 7, dropped: 3 }]);
  assert.deepEqual(snapshot.accounts.slice(1).map((account) => account.accountKey), folders.slice(0, 7).map((folder) => keyOf("codex", folder)));
  assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(snapshot).success, true);
});

test("Claude on macOS: an explicit CLAUDE_CONFIG_DIR is its own Keychain sign-in, keyed by the raw string and read with it as given", () => {
  const mac: CredentialLocationContext = { ...CTX, platform: "darwin" };
  const homes: RuntimeAccountUsageAccountHome[] = [
    { agentIds: ["explicit-default"], env: { CLAUDE_CONFIG_DIR: "/home/agent/.claude" } },
    { agentIds: ["c1"], env: { CLAUDE_CONFIG_DIR: "/srv/c" } },
    { agentIds: ["c2"], env: { CLAUDE_CONFIG_DIR: "/srv/c/" } },
    { agentIds: ["c3"], env: { CLAUDE_CONFIG_DIR: " /srv/c " } },
    { agentIds: ["h1"], env: { HOME: "/home/agent" } },
  ];
  const plan = planRuntimeAccountUsageFolders("claude", homes, mac);
  assert.deepEqual(plan.folders.map((folder) => [folder.folder, folder.agentIds, folder.env]), [
    ["keychain:/home/agent/.claude", ["explicit-default"], { CLAUDE_CONFIG_DIR: "/home/agent/.claude" }],
    ["keychain:/srv/c", ["c1", "c3"], { CLAUDE_CONFIG_DIR: "/srv/c" }],
    ["keychain:/srv/c/", ["c2"], { CLAUDE_CONFIG_DIR: "/srv/c/" }],
  ], "never merged into the default account; deduped by the trimmed string only; HOME alone still resolves to the default");
  // Elsewhere, and for Codex on macOS, folders are path-resolved as before.
  assert.deepEqual(planRuntimeAccountUsageFolders("claude", homes, CTX).folders.map((folder) => [folder.folder, folder.agentIds]), [["/srv/c", ["c1", "c2", "c3"]]]);
  assert.deepEqual(planRuntimeAccountUsageFolders("codex", [{ agentIds: ["x1"], env: { CODEX_HOME: "/srv/x" } }, { agentIds: ["x2"], env: { CODEX_HOME: "/srv/x/" } }], mac).folders.map((folder) => folder.agentIds), [["x1", "x2"]]);
});
