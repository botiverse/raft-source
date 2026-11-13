/** Unit tests for `raftdev preview` decisions (scripts/dev/raftdev-preview.ts); no systemd, Docker or processes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PREVIEW_INVALID_DBUS_ADDRESS,
  buildPreviewRecord,
  cancelPreviewReminder,
  descendantPids,
  dockerInspectState,
  formatCleanupLeftovers,
  isInUnitCgroup,
  janitorDecision,
  listPreviewRecords,
  parseCleanerStopOutput,
  parseContainerInspect,
  parsePreviewUnitSpec,
  previewAdoptionRefusal,
  previewSeedRefusal,
  shouldStartDaemonWindow,
  previewDroppedResources,
  previewIdentityChanges,
  provisionalPreviewRecord,
  runningPreviewRecord,
  withPreviewContainer,
  withPreviewProcesses,
  withPreviewVolume,
  parseNotifyTarget,
  parsePreviewDuration,
  parsePreviewStartArgs,
  parseProcStat,
  parseScheduledReminderId,
  previewLoginLines,
  previewOwner,
  previewRecordProblems,
  previewRegistryDir,
  previewReminderScheduleArgs,
  previewStopUnitArgs,
  previewSystemdRunArgs,
  previewUnitEnv,
  processesOutsideUnit,
  resolvePreviewResources,
  schedulePreviewReminder,
  selectPreviewRecord,
  summarizePreviewRecord,
  tmuxSessionFromArgs,
  verifyPreviewCleanup,
  volumesFromMounts,
  webAutoLoginEnv,
  previewSeedPasswordEnv,
  previewDockerEndpointRefusal,
  registryFromCleanerEnv,
  withDockerMemoryCap,
  type CommandRunner,
  type PreviewIdentity,
  type PreviewRecordInput,
} from "./raftdev-preview";

const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const BOOT = "44444444-4444-4444-8444-444444444444";
const CID_A = "a".repeat(64);
const CID_B = "b".repeat(64);

function recordInput(overrides: Partial<PreviewRecordInput> = {}): PreviewRecordInput {
  return {
    id: ID,
    name: "review-x",
    owner: { agentId: AGENT, name: "kirby", serverId: SERVER },
    repo: "/work/slock",
    branch: "agent/kirby/x",
    commit: "0123456789abcdef0123456789abcdef01234567",
    url: "https://x.trycloudflare.com",
    createdAt: new Date("2026-11-01T12:00:00.000Z"),
    deadlineAt: new Date("2026-11-01T14:00:00.000Z"),
    withAgentRuns: false,
    resources: resolvePreviewResources(undefined, undefined),
    dockerMemoryCaps: { postgres: "1g" },
    bootId: BOOT,
    unitInvocationId: "0123456789abcdef0123456789abcdef",
    processes: [
      { pid: 100, starttime: "5000", role: "server" },
      { pid: 101, starttime: "5001", role: "vite" },
      { pid: 100, starttime: "5000", role: "tmux:server:child" },
    ],
    containerIds: [CID_A, CID_B, CID_A],
    volumeNames: ["anon0123", "slock-dev-review-x-rustfs-data", "anon0123"],
    notify: { target: "#triage", messageId: "f85040e1" },
    reminderId: "abcd1234",
    ...overrides,
  };
}

test("parsePreviewDuration: default 2h, h/m/s forms, zero and over 8h refused", () => {
  assert.equal(parsePreviewDuration(undefined), 7200);
  assert.equal(parsePreviewDuration("90m"), 5400);
  assert.equal(parsePreviewDuration("2h"), 7200);
  assert.equal(parsePreviewDuration("1h30m"), 5400);
  assert.equal(parsePreviewDuration("8h"), 28800);
  assert.throws(() => parsePreviewDuration("8h1m"), /capped at 8h/);
  assert.throws(() => parsePreviewDuration("9h"), /capped at 8h/);
  assert.throws(() => parsePreviewDuration("0m"), /longer than zero/);
  assert.throws(() => parsePreviewDuration(""), /duration like/);
  assert.throws(() => parsePreviewDuration("2 hours"), /duration like/);
  assert.throws(() => parsePreviewDuration("30m2h"), /duration like/);
});

test("previewRegistryDir: RAFT_PREVIEW_REGISTRY, else the cleaner env file, else XDG_STATE_HOME, else ~/.local/state", () => {
  const file = "# timer override\nRAFT_PREVIEW_REGISTRY=/srv/previews\n";
  assert.equal(previewRegistryDir({ RAFT_PREVIEW_REGISTRY: "/r", XDG_STATE_HOME: "/x" }, "/home/u", file), "/r");
  assert.equal(previewRegistryDir({ XDG_STATE_HOME: "/x" }, "/home/u", file), "/srv/previews");
  assert.equal(previewRegistryDir({ XDG_STATE_HOME: "/x" }, "/home/u"), "/x/raft/previews");
  assert.equal(previewRegistryDir({ RAFT_PREVIEW_REGISTRY: "  ", XDG_STATE_HOME: "" }, "/home/u", null), "/home/u/.local/state/raft/previews");
  assert.equal(registryFromCleanerEnv('RAFT_PREVIEW_REGISTRY="/q/p"\n'), "/q/p");
  assert.equal(registryFromCleanerEnv("OTHER=1\n"), null);
  // ~ and relative paths resolve as the cleaner resolves them.
  assert.equal(previewRegistryDir({ RAFT_PREVIEW_REGISTRY: "~/p" }, "/home/u", null, "/cwd"), "/home/u/p");
  assert.equal(previewRegistryDir({ RAFT_PREVIEW_REGISTRY: "rel/p" }, "/home/u", null, "/cwd"), "/cwd/rel/p");
  assert.equal(previewRegistryDir({}, "/home/u", "RAFT_PREVIEW_REGISTRY=~/q\n", "/cwd"), "/home/u/q");
});

test("resource profiles: local-stack default 4G, frontend 2G, --memory-max recorded as override", () => {
  assert.deepEqual(resolvePreviewResources(undefined, undefined), { profile: "local-stack", memoryMax: "4G", memoryMaxOverride: null });
  assert.deepEqual(resolvePreviewResources("frontend", undefined), { profile: "frontend", memoryMax: "2G", memoryMaxOverride: null });
  assert.deepEqual(resolvePreviewResources("frontend", "3g"), { profile: "frontend", memoryMax: "3G", memoryMaxOverride: "3G" });
  assert.throws(() => resolvePreviewResources("huge", undefined), /unknown --profile/);
  assert.throws(() => resolvePreviewResources(undefined, "lots"), /--memory-max/);
});

test("withDockerMemoryCap adds --memory and --memory-swap after run, only with a cap", () => {
  const args = ["run", "-d", "--name", "pg", "postgres:16-alpine"];
  assert.deepEqual(withDockerMemoryCap(args, "1g"), ["run", "--memory", "1g", "--memory-swap", "1g", "-d", "--name", "pg", "postgres:16-alpine"]);
  assert.deepEqual(withDockerMemoryCap(args, undefined), args);
});

test("parseNotifyTarget splits a trailing message id into messageId", () => {
  assert.deepEqual(parseNotifyTarget("#triage:f85040e1"), { target: "#triage", messageId: "f85040e1" });
  assert.deepEqual(parseNotifyTarget("dm:@Artea:abcd1234"), { target: "dm:@Artea", messageId: "abcd1234" });
  assert.deepEqual(parseNotifyTarget("dm:@Artea"), { target: "dm:@Artea", messageId: null });
  assert.deepEqual(parseNotifyTarget("#general"), { target: "#general", messageId: null });
  assert.deepEqual(parseNotifyTarget(`#triage:${ID}`), { target: "#triage", messageId: ID });
  assert.throws(() => parseNotifyTarget("#triage:"), /empty message id/);
  assert.throws(() => parseNotifyTarget("two words"), /--notify/);
});

test("parsePreviewStartArgs keeps preview flags and passes the rest to start", () => {
  const parsed = parsePreviewStartArgs([
    "rev", "--for", "90m", "--with-agent-runs", "--profile=frontend", "--notify", "#triage:f85040e1",
    "--description", "for Tenny", "--no-risingwave",
  ]);
  assert.equal(parsed.name, "rev");
  assert.equal(parsed.forSeconds, 5400);
  assert.equal(parsed.withAgentRuns, true);
  assert.equal(parsed.resources.profile, "frontend");
  assert.deepEqual(parsed.notify, { target: "#triage", messageId: "f85040e1" });
  assert.deepEqual(parsed.startArgs, ["--description", "for Tenny", "--no-risingwave"]);
  assert.throws(() => parsePreviewStartArgs(["stop"]), /subcommand/);
  assert.throws(() => parsePreviewStartArgs(["--for", "1h"]), /name first/);
  assert.throws(() => parsePreviewStartArgs(["rev", "--for", "9h"]), /capped/);
});

test("previewOwner reads the Raft agent env and never invents an id", () => {
  assert.deepEqual(
    previewOwner({ SLOCK_AGENT_ID: AGENT, SLOCK_CURRENT_SERVER_ID: SERVER, USER: "ubuntu" }),
    { agentId: AGENT, name: "ubuntu", serverId: SERVER },
  );
  assert.deepEqual(previewOwner({ USER: "dev" }), { agentId: null, name: "dev", serverId: null });
  assert.equal(previewOwner({ SLOCK_AGENT_ID: "not-a-uuid", USER: "dev" }).agentId, null);
});

test("record shape meets the contract: UUID id, string starttime, 64-hex ids, unique volumes, notify + reminderId", () => {
  const record = buildPreviewRecord(recordInput());
  assert.deepEqual(previewRecordProblems(record), []);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, ID);
  assert.equal(record.name, "review-x");
  assert.equal(record.unitName, `raft-preview-${ID}.service`);
  assert.equal(record.createdAt, "2026-11-01T12:00:00Z");
  assert.equal(record.deadlineAt, "2026-11-01T14:00:00Z");
  assert.equal(record.idleTtlSeconds, 3600);
  assert.equal(record.profile, "local-stack");
  assert.equal(record.memoryMax, "4G");
  assert.equal(record.memoryMaxOverride, null);
  assert.deepEqual(record.processes, [
    { pid: 100, starttime: "5000", role: "server" },
    { pid: 101, starttime: "5001", role: "vite" },
  ]);
  for (const p of record.processes) assert.equal(typeof p.starttime, "string");
  assert.deepEqual(record.containerIds, [CID_A, CID_B]);
  assert.deepEqual(record.volumeNames, ["anon0123", "slock-dev-review-x-rustfs-data"]);
  assert.deepEqual(record.notify, { target: "#triage", messageId: "f85040e1" });
  assert.equal(record.reminderId, "abcd1234");
  assert.ok(!("lastActivityAt" in record), "lastActivityAt is never fabricated");
  // No credentials or shell commands: only the documented keys.
  assert.deepEqual(Object.keys(record).sort(), [
    "bootId", "branch", "commit", "containerIds", "createdAt", "deadlineAt", "dockerMemoryCaps", "id",
    "idleTtlSeconds", "kind", "memoryMax", "memoryMaxOverride", "name", "notify", "owner", "processes",
    "profile", "reminderId", "repo", "schemaVersion", "stage", "unitInvocationId", "unitName", "url", "volumeNames",
    "withAgentRuns",
  ]);
});

test("previewRecordProblems refuses what the cleaner would refuse", () => {
  const base = buildPreviewRecord(recordInput());
  const problems = (patch: Record<string, unknown>) => previewRecordProblems({ ...base, ...patch });
  assert.match(problems({ id: "review-x" }).join(), /UUID/);
  assert.match(problems({ processes: [{ pid: 100, starttime: 5000, role: "server" }] }).join(), /starttime must be a digit string/);
  assert.match(problems({ processes: [{ pid: 1, starttime: "5", role: "init" }] }).join(), /invalid process pid/);
  assert.match(problems({ containerIds: ["slock-dev-x-pg"] }).join(), /64-hex/);
  assert.match(problems({ containerIds: [CID_A, CID_A] }).join(), /unique/);
  assert.match(problems({ volumeNames: ["/home/u/bind"] }).join(), /volume names/);
  assert.match(problems({ deadlineAt: "2026-11-01T20:00:01Z" }).join(), /at most 8h/);
  assert.match(problems({ deadlineAt: "2026-11-01T14:00:00" }).join(), /timezone/);
  assert.match(problems({ unitInvocationId: "xyz" }).join(), /InvocationID/);
  assert.match(problems({ unitName: "other.service" }).join(), /unitName/);
  assert.match(problems({ idleTtlSeconds: 0 }).join(), /3600/);
  assert.match(problems({ notify: { target: "#x" } }).join(), /notify/);
  assert.match(problems({ reminderId: 7 }).join(), /reminderId/);
  assert.match(problems({ owner: { agentId: null, name: "dev", serverId: null } }).join(), /agentId/);
  assert.deepEqual(problems({ notify: null, reminderId: null }), []);
});

test("volumesFromMounts keeps only Type volume mounts, anonymous ones included, never bind paths", () => {
  const mounts = JSON.stringify([
    { Type: "volume", Name: "9f2c0d1e4b", Source: "/var/lib/docker/volumes/9f2c0d1e4b/_data", Destination: "/var/lib/postgresql/data" },
    { Type: "volume", Name: "slock-dev-x-rustfs-data", Destination: "/data" },
    { Type: "bind", Source: "/work/.slockdev/x/otelcol.yaml", Destination: "/etc/otelcol-contrib/config.yaml" },
    { Type: "tmpfs", Destination: "/tmp" },
  ]);
  assert.deepEqual(volumesFromMounts(mounts), ["9f2c0d1e4b", "slock-dev-x-rustfs-data"]);
  assert.deepEqual(volumesFromMounts("not json"), []);
});

test("parseProcStat reads ppid and starttime (field 22) after the last ')'", () => {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[0] = "S";
  fields[1] = "77";
  fields[19] = "987654321";
  const stat = parseProcStat(`4242 (node (vite) x) ${fields.join(" ")}`);
  assert.deepEqual(stat, { comm: "node (vite) x", state: "S", ppid: 77, starttime: "987654321" });
  assert.equal(parseProcStat("garbage"), null);
});

test("descendantPids walks the whole tree below the roots", () => {
  const parents = new Map([[10, 1], [11, 10], [12, 11], [13, 1], [14, 12]]);
  assert.deepEqual(descendantPids([10], parents).sort(), [11, 12, 14]);
});

test("cgroup check: every recorded process must be in raft-preview-<id>.service", () => {
  const unit = `raft-preview-${ID}.service`;
  const inside = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
  const tmuxScope = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1234.scope\n";
  const v1 = `12:memory:/x\n1:name=systemd:/user.slice/user@1000.service/${unit}\n`;
  assert.equal(isInUnitCgroup(inside, unit), true);
  assert.equal(isInUnitCgroup(v1, unit), true);
  assert.equal(isInUnitCgroup(tmuxScope, unit), false);
  assert.equal(isInUnitCgroup(`0::/x/${unit}-other\n`, unit), false);
  assert.equal(isInUnitCgroup(null, unit), false);
  const processes = [
    { pid: 100, starttime: "1", role: "server" },
    { pid: 101, starttime: "2", role: "tmux-server" },
    { pid: 102, starttime: "3", role: "cloudflared" },
  ];
  const cgroups = new Map([[100, inside], [101, tmuxScope]]);
  assert.deepEqual(
    processesOutsideUnit(processes, unit, (pid) => cgroups.get(pid) ?? null).map((p) => p.role),
    ["tmux-server", "cloudflared"],
  );
});

test("systemd-run args: the unit name, limits, and a job-local invalid session bus after --", () => {
  const args = previewSystemdRunArgs({
    id: ID,
    memoryMax: "4G",
    runtimeMaxSeconds: 7200,
    workingDirectory: "/work/slock",
    logFile: "/work/slock/.slockdev/x/preview-unit.log",
    command: ["/usr/bin/node", "raftdev.ts", "__preview-unit", "/spec.json"],
  });
  assert.ok(args.includes(`--unit=raft-preview-${ID}.service`));
  for (const property of ["MemoryMax=4G", "MemorySwapMax=0", "RuntimeMaxSec=7200", "KillMode=control-group", "TimeoutStopSec=15s"]) {
    assert.equal(args[args.indexOf(property) - 1], "-p", property);
  }
  const separator = args.indexOf("--");
  assert.deepEqual(args.slice(separator + 1, separator + 3), ["/usr/bin/env", `DBUS_SESSION_BUS_ADDRESS=${PREVIEW_INVALID_DBUS_ADDRESS}`]);
  assert.ok(!args.slice(0, separator).some((arg) => arg.includes("DBUS")), "systemd-run itself keeps the real bus");
});

const LAUNCH_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DOCKER_HOST: "unix:///run/user/1000/docker.sock",
  NODE_OPTIONS: "--max-old-space-size=4096",
  VITE_SLOCKDEV_EMAIL: "admin@slock.ai",
  SLOCKDEV_TRACE_OBSERVE: "0",
  RAFTDEV_RISINGWAVE: "0",
  // Never passed:
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  INVOCATION_ID: "x",
  TMUX: "/tmp/tmux-1000/default,1,0",
  SLOCK_AGENT_TOKEN: "secret",
  SLOCK_AGENT_PROXY_TOKEN_FILE: "/t",
  SLOCK_AGENT_ID: AGENT,
  RAFT_AGENT_TOKEN: "secret",
  RAFT_PROFILE: "kirby",
  SLOCK_CLI_TRANSPORT_DIR: "/c",
  CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  CLAUDE_CODE_OAUTH_TOKEN: "secret",
  FOO_API_KEY: "secret",
  GITHUB_TOKEN: "secret",
  GOOGLE_CLIENT_SECRET: "secret",
  SLOCKDEV_SCOPE_ATTESTATION_SECRET: "secret",
  VITE_SOME_TOKEN: "secret",
  ANTHROPIC_API_KEY: "model-key",
  OPENAI_API_KEY: "model-key",
  CODEX_HOME: "/home/u/.codex",
};
const BASE_UNIT_ENV = {
  PATH: "/usr/bin", HOME: "/home/u", USER: "u", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm",
  XDG_RUNTIME_DIR: "/run/user/1000",
  NODE_OPTIONS: "--max-old-space-size=4096", VITE_SLOCKDEV_EMAIL: "admin@slock.ai",
  SLOCKDEV_TRACE_OBSERVE: "0", RAFTDEV_RISINGWAVE: "0",
};

test("previewUnitEnv without agent runs: the allowlist only; no model keys, tokens, secrets, RAFT_* or CLAUDE_*", () => {
  assert.deepEqual(previewUnitEnv(LAUNCH_ENV, { withAgentRuns: false }), BASE_UNIT_ENV);
});

test("previewUnitEnv with agent runs adds only the daemon's model/runtime variables, never Raft CLI tokens", () => {
  const env = previewUnitEnv(LAUNCH_ENV, { withAgentRuns: true });
  assert.deepEqual(env, {
    ...BASE_UNIT_ENV,
    ANTHROPIC_API_KEY: "model-key",
    OPENAI_API_KEY: "model-key",
    CODEX_HOME: "/home/u/.codex",
  });
  for (const key of ["CLAUDE_CODE_MESSAGING_TOKEN", "RAFT_PROFILE", "FOO_API_KEY", "SLOCK_AGENT_TOKEN", "RAFT_AGENT_TOKEN"]) {
    assert.ok(!(key in env), key);
  }
});

test("tmuxSessionFromArgs finds the addressed session for socket routing", () => {
  assert.equal(tmuxSessionFromArgs(["send-keys", "-t", "slock-x:web", "C-c"]), "slock-x");
  assert.equal(tmuxSessionFromArgs(["new-session", "-d", "-s", "slock-x", "-n", "server"]), "slock-x");
  assert.equal(tmuxSessionFromArgs(["list-sessions", "-F", "#{session_name}"]), null);
  // list-panes' -s is a bare flag (all panes of the session), not a value.
  assert.equal(
    tmuxSessionFromArgs(["list-panes", "-s", "-t", "slock-x", "-F", "#{window_name}\t#{pane_pid}"]),
    "slock-x",
  );
  assert.equal(tmuxSessionFromArgs(["move-window", "-s", "slock-x:2", "-t", "other:3"]), "slock-x");
});

test("janitorDecision stops at the deadline even when the preview is not idle", () => {
  const now = 1_000_000;
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now - 5, idleTtlSeconds: 3600, deadlineAtSeconds: now }),
    { action: "stop", reason: "deadline", idleSeconds: 5 },
  );
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now, idleTtlSeconds: 0, deadlineAtSeconds: now - 1 }),
    { action: "stop", reason: "deadline", idleSeconds: 0 },
  );
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now - 3600, idleTtlSeconds: 3600, deadlineAtSeconds: now + 999 }),
    { action: "stop", reason: "idle", idleSeconds: 3600 },
  );
  // Waits until whichever comes first, at most 60s per tick.
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now, idleTtlSeconds: 3600, deadlineAtSeconds: now + 20 }),
    { action: "wait", sleepSeconds: 20 },
  );
  // Without a deadline: the pre-preview idle-only behaviour.
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now - 3590, idleTtlSeconds: 3600, deadlineAtSeconds: null }),
    { action: "wait", sleepSeconds: 10 },
  );
  assert.deepEqual(
    janitorDecision({ nowSeconds: now, lastActivitySeconds: now, idleTtlSeconds: 3600, deadlineAtSeconds: null }),
    { action: "wait", sleepSeconds: 60 },
  );
});

test("the janitor's stop runs as a separate unit with the record's registry", () => {
  const args = previewStopUnitArgs({
    id: ID, reason: "deadline", nodePath: "/usr/bin/node", raftdevScript: "/w/scripts/dev/raftdev.ts",
    workingDirectory: "/w", registryDir: "/r", path: "/usr/bin",
    dockerEnv: { DOCKER_HOST: "unix:///d.sock", DOCKER_CONTEXT: "rootless", OTHER: "x" },
  });
  assert.ok(args.includes(`--unit=raft-preview-${ID}-stop.service`));
  assert.ok(args.includes("--setenv=RAFT_PREVIEW_REGISTRY=/r"));
  assert.ok(args.includes("--setenv=DOCKER_HOST=unix:///d.sock"));
  assert.ok(args.includes("--setenv=DOCKER_CONTEXT=rootless"));
  assert.ok(!args.some((arg) => arg.includes("OTHER")));
  assert.deepEqual(args.slice(-5), ["preview", "stop", ID, "--reason", "deadline"]);
});

test("HARD RULE: --with-agent-runs forces skip-auto-login and prints no passwordless link", () => {
  const callerEnv = { VITE_SLOCKDEV_EMAIL: "admin@slock.ai", VITE_SLOCKDEV_SKIP_AUTO_LOGIN: "" };
  assert.deepEqual(
    webAutoLoginEnv({ preview: true, withAgentRuns: true, env: callerEnv }),
    [["VITE_SLOCKDEV_SKIP_AUTO_LOGIN", "1"]],
  );
  const accounts = [
    { role: "owner", email: "dev@slock.ai", password: "password123" },
    { role: "admin", email: "admin@slock.ai", password: "password123" },
  ];
  const url = "https://x.trycloudflare.com";
  const withRuns = previewLoginLines({ url, withAgentRuns: true, accounts, env: callerEnv });
  assert.ok(!withRuns.some((line) => /passwordless link/i.test(line)), withRuns.join("\n"));
  assert.ok(!withRuns.some((line) => line.includes(url)), "no link at all with agent runs");
  assert.ok(withRuns.some((line) => line.includes("admin@slock.ai / password123")));

  const without = previewLoginLines({ url, withAgentRuns: false, accounts, env: {} });
  assert.ok(without.some((line) => line === `  Passwordless link (owner, dev@slock.ai): ${url}`), without.join("\n"));
  const bound = previewLoginLines({ url, withAgentRuns: false, accounts, env: { VITE_SLOCKDEV_EMAIL: "admin@slock.ai" } });
  assert.ok(bound.some((line) => line.startsWith("  Passwordless link (admin, admin@slock.ai)")));
});

test("webAutoLoginEnv leaves plain start (and previews without agent runs) as before", () => {
  const env = { VITE_SLOCKDEV_SKIP_AUTO_LOGIN: "1", VITE_SLOCKDEV_EMAIL: "member@slock.ai" };
  const expected = [["VITE_SLOCKDEV_SKIP_AUTO_LOGIN", "1"], ["VITE_SLOCKDEV_EMAIL", "member@slock.ai"]];
  assert.deepEqual(webAutoLoginEnv({ preview: false, withAgentRuns: true, env }), expected);
  assert.deepEqual(webAutoLoginEnv({ preview: true, withAgentRuns: false, env }), expected);
  assert.deepEqual(webAutoLoginEnv({ preview: false, withAgentRuns: false, env: {} }), []);
});

test("verifyPreviewCleanup reports leftovers by pid+starttime+boot, container id and volume", () => {
  const record = buildPreviewRecord(recordInput());
  const starttimes = new Map([[100, "5000"], [101, "9999"]]); // 101's pid was reused: not ours
  const result = verifyPreviewCleanup(record, {
    bootId: BOOT,
    starttimeOf: (pid) => starttimes.get(pid) ?? null,
    unitActive: () => "gone",
    containerState: (id) => (id === CID_B ? "unknown" : "gone"),
    volumeState: (name) => (name === "anon0123" ? "present" : "gone"),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.processes, [{ pid: 100, starttime: "5000", role: "server" }]);
  assert.deepEqual(result.containers, [{ id: CID_B, state: "unknown" }]);
  assert.deepEqual(result.volumes, [{ name: "anon0123", state: "present" }]);
  assert.deepEqual(formatCleanupLeftovers(result, record.unitName), [
    "  process pid 100 starttime 5000 (server) is still running",
    `  container ${"b".repeat(12)} could not be checked`,
    "  volume anon0123 still exists",
  ]);

  const otherBoot = verifyPreviewCleanup(record, {
    bootId: "55555555-5555-4555-8555-555555555555",
    starttimeOf: (pid) => starttimes.get(pid) ?? null,
    unitActive: () => "gone",
    containerState: () => "gone",
    volumeState: () => "gone",
  });
  assert.equal(otherBoot.ok, true, "after a reboot the recorded processes are gone, not to be signalled");

  const activeUnit = verifyPreviewCleanup(record, {
    bootId: BOOT, starttimeOf: () => null, unitActive: () => "present", containerState: () => "gone", volumeState: () => "gone",
  });
  assert.equal(activeUnit.ok, false);
});

test("dockerInspectState treats only 'No such' as gone", () => {
  assert.equal(dockerInspectState({ code: 0, stderr: "" }), "present");
  assert.equal(dockerInspectState({ code: 1, stderr: "Error: No such container: abc" }), "gone");
  assert.equal(dockerInspectState({ code: 1, stderr: "Error response from daemon: No such volume: v" }), "gone");
  assert.equal(dockerInspectState({ code: 1, stderr: "Cannot connect to the Docker daemon" }), "unknown");
});

test("parseCleanerStopOutput reads the cleaner's result", () => {
  assert.equal(parseCleanerStopOutput(JSON.stringify({ outcome: "cleaned", errors: [], residual: {} })).outcome, "cleaned");
  assert.equal(parseCleanerStopOutput("null\n").outcome, "absent");
  const incomplete = parseCleanerStopOutput(JSON.stringify({ outcome: "incomplete", errors: ["stop unit: x"], residual: { volumes: ["v"] } }));
  assert.equal(incomplete.outcome, "incomplete");
  assert.deepEqual(incomplete.detail, ["  error: stop unit: x", '  residual volumes: ["v"]']);
});

test("reminder: scheduled at deadline + 10 minutes, anchored to the source message", () => {
  const args = previewReminderScheduleArgs({
    id: ID, name: "rev", deadlineAt: new Date("2026-11-01T14:00:00.000Z"),
    notify: { target: "#triage", messageId: "f85040e1" },
  });
  assert.equal(args[args.indexOf("--fire-at") + 1], "2026-11-01T14:10:00Z");
  assert.equal(args[args.indexOf("--channel") + 1], "#triage");
  assert.equal(args[args.indexOf("--message-id") + 1], "f85040e1");
  assert.equal(parseScheduledReminderId("Reminder scheduled: #abcd1234 once 2026-11-01T14:10:00Z \"x\"\n"), "abcd1234");

  const calls: string[][] = [];
  const ok: CommandRunner = (command, a) => { calls.push([command, ...a]); return { code: 0, stdout: "Reminder scheduled: #abcd1234 once\n", stderr: "" }; };
  assert.deepEqual(
    schedulePreviewReminder({ id: ID, name: "rev", deadlineAt: new Date(), notify: { target: "#t", messageId: null } }, ok),
    { reminderId: "abcd1234", warning: null },
  );
  assert.equal(calls[0]![0], "raft");
  const failing: CommandRunner = () => ({ code: 1, stdout: "", stderr: "not logged in\n" });
  const failed = schedulePreviewReminder({ id: ID, name: "rev", deadlineAt: new Date(), notify: { target: "#t", messageId: null } }, failing);
  assert.equal(failed.reminderId, null);
  assert.match(failed.warning ?? "", /not logged in/);
});

test("a recorded reminder is cancelled on stop with raft reminder cancel --id", () => {
  const record = buildPreviewRecord(recordInput());
  const calls: string[][] = [];
  const runner: CommandRunner = (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "Reminder canceled", stderr: "" }; };
  assert.deepEqual(cancelPreviewReminder(record.reminderId, runner), { attempted: true, ok: true, message: "reminder #abcd1234 cancelled" });
  assert.deepEqual(calls, [["raft", "reminder", "cancel", "--id", "abcd1234"]]);

  calls.length = 0;
  assert.equal(cancelPreviewReminder(null, runner).attempted, false);
  assert.deepEqual(calls, []);

  const failing: CommandRunner = () => ({ code: 1, stdout: "", stderr: "reminder not found\n" });
  const failed = cancelPreviewReminder("abcd1234", failing);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /reminder not found/);
});

test("selectPreviewRecord: by id, or by name preferring this checkout; ambiguity refused", () => {
  const a = buildPreviewRecord(recordInput());
  const b = { ...buildPreviewRecord(recordInput({ id: "66666666-6666-4666-8666-666666666666" })), repo: "/other" };
  const byId = selectPreviewRecord([a, b], b.id, "/work/slock");
  assert.ok("record" in byId && byId.record.id === b.id);
  const byName = selectPreviewRecord([a, b], "review-x", "/work/slock");
  assert.ok("record" in byName && byName.record.id === ID);
  const ambiguous = selectPreviewRecord([a, b], "review-x", "/elsewhere");
  assert.ok("error" in ambiguous && /several previews/.test(ambiguous.error));
  assert.ok("error" in selectPreviewRecord([a], "nope", "/work/slock"));
});

test("summarizePreviewRecord: remaining time and recorded processes alive", () => {
  const record = buildPreviewRecord(recordInput());
  const summary = summarizePreviewRecord(record, Date.parse("2026-11-01T13:00:00Z"), BOOT, (pid) => (pid === 100 ? "5000" : null));
  assert.equal(summary.remainingSeconds, 3600);
  assert.equal(summary.processesAlive, 1);
  assert.equal(summary.processesRecorded, 2);
  assert.equal(summary.owner, "kirby");
});

test("listPreviewRecords reads <uuid>.json records only and checks the id matches the filename", () => {
  const root = mkdtempSync(join(tmpdir(), "raftdev-preview-registry-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const record = buildPreviewRecord(recordInput());
  mkdirSync(join(root, "results"));
  writeFileSync(join(root, `${ID}.json`), JSON.stringify(record));
  writeFileSync(join(root, "66666666-6666-4666-8666-666666666666.json"), JSON.stringify(record)); // id mismatch
  writeFileSync(join(root, "review-x.json"), JSON.stringify(record)); // not a UUID name
  writeFileSync(join(root, "results", `${ID}.json`), "{}");
  const listed = listPreviewRecords(root);
  assert.deepEqual(listed.map((entry) => [entry.id, entry.record?.id ?? null]), [
    [ID, ID],
    ["66666666-6666-4666-8666-666666666666", null],
  ]);
});

test("previews with agent runs seed a random password; everything else keeps the default", () => {
  const random = () => "r4nd0m-password";
  assert.deepEqual(previewSeedPasswordEnv({ preview: true, withAgentRuns: true, randomPassword: random }), [
    ["RAFTDEV_SEED_PASSWORD", "r4nd0m-password"],
  ]);
  assert.deepEqual(previewSeedPasswordEnv({ preview: true, withAgentRuns: false, randomPassword: random }), []);
  assert.deepEqual(previewSeedPasswordEnv({ preview: false, withAgentRuns: true, randomPassword: random }), []);
});

function identity(): PreviewIdentity {
  return {
    id: ID,
    name: "review-x",
    owner: { agentId: AGENT, name: "kirby", serverId: SERVER },
    repo: "/work/slock",
    branch: "agent/kirby/x",
    commit: "0123456789abcdef0123456789abcdef01234567",
    createdAt: new Date("2026-11-01T12:00:00.000Z"),
    deadlineAt: new Date("2026-11-01T14:00:00.000Z"),
    withAgentRuns: true,
    resources: resolvePreviewResources(undefined, undefined),
    dockerMemoryCaps: { postgres: "1g" },
    bootId: BOOT,
    unitInvocationId: "0123456789abcdef0123456789abcdef",
    notify: { target: "#triage", messageId: "f85040e1" },
    reminderId: "abcd1234",
  };
}

const supervisor = { pid: 4000, starttime: "4000", role: "supervisor" };

test("the provisional record (nothing created yet) passes the same contract checks", () => {
  const provisional = provisionalPreviewRecord(identity(), supervisor);
  assert.deepEqual(previewRecordProblems(provisional), []);
  assert.equal(provisional.stage, "starting");
  assert.equal(provisional.url, null);
  assert.deepEqual(provisional.processes, [supervisor]);
  assert.deepEqual(provisional.containerIds, []);
  assert.deepEqual(provisional.volumeNames, []);
  assert.equal(provisional.unitName, `raft-preview-${ID}.service`);
  assert.deepEqual(previewRecordProblems(provisionalPreviewRecord(identity())), [], "without the supervisor too");
  // url stays required once running.
  assert.match(previewRecordProblems({ ...provisional, stage: "running" }).join(), /url must be set/);
  assert.match(previewRecordProblems({ ...provisional, stage: "ready" }).join(), /stage must be/);
});

test("adding containers, volumes and processes keeps the immutable identity fields", () => {
  const provisional = provisionalPreviewRecord(identity(), supervisor);
  const steps = [
    withPreviewContainer(provisional, CID_A, ["anon-pg"]),
  ];
  steps.push(withPreviewVolume(steps[0]!, "slock-dev-review-x-rustfs-data"));
  steps.push(withPreviewContainer(steps[1]!, CID_B, ["slock-dev-review-x-rustfs-data"]));
  steps.push(withPreviewProcesses(steps[2]!, [{ pid: 4001, starttime: "4001", role: "cloudflared" }]));
  steps.push(runningPreviewRecord(steps[3]!, {
    url: "https://x.trycloudflare.com", processes: [], containerIds: [], volumeNames: [], dockerMemoryCaps: { postgres: "1g" },
  }));
  let previous = provisional;
  for (const next of steps) {
    assert.deepEqual(previewIdentityChanges(previous, next), []);
    assert.deepEqual(previewRecordProblems(next), []);
    for (const field of ["bootId", "unitName", "unitInvocationId", "createdAt"] as const) assert.equal(next[field], provisional[field]);
    assert.equal(next.owner.agentId, provisional.owner.agentId);
    previous = next;
  }
  assert.deepEqual(
    previewIdentityChanges(provisional, { ...provisional, unitInvocationId: "f".repeat(32), createdAt: "2026-11-01T12:00:01Z" }),
    ["unitInvocationId", "createdAt"],
  );
});

test("the record-building order never drops a previously recorded container, volume or process", () => {
  let record = provisionalPreviewRecord(identity(), supervisor);
  const history = [record];
  record = withPreviewContainer(record, CID_A, ["anon-pg"]);
  history.push(record);
  record = withPreviewContainer(record, CID_B, []);
  history.push(record);
  record = withPreviewContainer(record, CID_A, ["anon-pg"]); // re-recording is idempotent
  history.push(record);
  record = withPreviewProcesses(record, [{ pid: 4000, starttime: "9", role: "reused-pid" }, { pid: 4002, starttime: "1", role: "vite" }]);
  history.push(record);
  // The final collection no longer sees CID_A (say it exited): it stays recorded.
  record = runningPreviewRecord(record, {
    url: "https://x.trycloudflare.com",
    processes: [{ pid: 4003, starttime: "2", role: "server" }],
    containerIds: [CID_B],
    volumeNames: [],
    dockerMemoryCaps: {},
  });
  history.push(record);
  for (let i = 1; i < history.length; i++) {
    assert.deepEqual(previewDroppedResources(history[i - 1]!, history[i]!), [], `step ${i}`);
  }
  assert.deepEqual(record.containerIds, [CID_A, CID_B]);
  assert.deepEqual(record.volumeNames, ["anon-pg"]);
  assert.deepEqual(record.processes.map((p) => [p.pid, p.role]), [[4000, "supervisor"], [4002, "vite"], [4003, "server"]]);
  assert.deepEqual(
    previewDroppedResources(record, { ...record, containerIds: [CID_B] }),
    [`container ${CID_A}`],
  );
});

test("parseContainerInspect: only 'No such' is absence; a failed query is unknown", () => {
  const mounts = JSON.stringify([
    { Type: "volume", Name: "anon-pg" },
    { Type: "bind", Source: "/work/x.yaml" },
  ]);
  assert.deepEqual(parseContainerInspect({ code: 0, stdout: `${CID_A}\t${mounts}\n`, stderr: "" }), {
    state: "present", id: CID_A, volumeNames: ["anon-pg"],
  });
  assert.deepEqual(parseContainerInspect({ code: 1, stdout: "", stderr: "Error: No such container: slock-dev-x-pg\n" }), { state: "gone" });
  assert.deepEqual(parseContainerInspect({ code: 1, stdout: "", stderr: "Error: No such object: slock-dev-x-pg\n" }), { state: "gone" });
  const daemon = parseContainerInspect({
    code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
  });
  assert.equal(daemon.state, "unknown");
  const permission = parseContainerInspect({
    code: 1, stdout: "", stderr: "permission denied while trying to connect to the Docker daemon socket\n",
  });
  assert.equal(permission.state, "unknown");
  assert.equal(parseContainerInspect({ code: 0, stdout: "slock-dev-x-pg\tnull", stderr: "" }).state, "unknown");
  assert.equal(parseContainerInspect({ code: 0, stdout: `${CID_A}\tnot-json`, stderr: "" }).state, "unknown");
});

test("stop verification never counts a failed Docker or systemd query as gone", () => {
  const record = buildPreviewRecord(recordInput());
  const unknownEverywhere = verifyPreviewCleanup(record, {
    bootId: BOOT,
    starttimeOf: () => null,
    unitActive: () => "unknown",
    containerState: () => dockerInspectState({ code: 1, stderr: "Cannot connect to the Docker daemon" }),
    volumeState: () => dockerInspectState({ code: 1, stderr: "permission denied" }),
  });
  assert.equal(unknownEverywhere.ok, false);
  assert.equal(unknownEverywhere.unit, "unknown");
  assert.deepEqual(unknownEverywhere.containers.map((c) => c.state), ["unknown", "unknown"]);
  assert.deepEqual(unknownEverywhere.volumes.map((v) => v.state), ["unknown", "unknown"]);
});

test("previewAdoptionRefusal refuses any existing or unanswerable container or volume of the name", () => {
  const gone = (kind: "container" | "volume", name: string) => ({ kind, name, state: "gone" as const });
  assert.equal(previewAdoptionRefusal("rev", [gone("container", "slock-dev-rev-pg"), gone("volume", "slock-dev-rev-rustfs-data")]), null);
  const existing = previewAdoptionRefusal("rev", [
    gone("container", "slock-dev-rev-pg"),
    { kind: "container", name: "slock-dev-rev-redis", state: "present" },
    { kind: "volume", name: "slock-dev-rev-rustfs-data", state: "unknown" },
  ]);
  assert.ok(existing);
  assert.ok(existing.some((line) => line.includes("container slock-dev-rev-redis exists")));
  assert.ok(existing.some((line) => line.includes("volume slock-dev-rev-rustfs-data could not be checked")));
  assert.ok(!existing.some((line) => line.includes("slock-dev-rev-pg")));
  assert.ok(existing.some((line) => line.includes("./raftdev stop rev") && line.includes("new preview name")));
});

test("a preview without --with-agent-runs has no daemon window; plain start always has one", () => {
  assert.equal(shouldStartDaemonWindow({ preview: true, withAgentRuns: false }), false);
  assert.equal(shouldStartDaemonWindow({ preview: true, withAgentRuns: true }), true);
  assert.equal(shouldStartDaemonWindow({ preview: false, withAgentRuns: false }), true);
  assert.equal(shouldStartDaemonWindow({ preview: false, withAgentRuns: true }), true);
});

test("raftdev seed on a preview is refused; on a plain environment it proceeds", () => {
  assert.equal(previewSeedRefusal("dev", null), null);
  const refusal = previewSeedRefusal("rev", {
    schemaVersion: 1, id: ID, deadlineAt: "2026-11-01T14:00:00Z", registryDir: "/r", tmuxSocket: `raft-preview-${ID}`,
  });
  assert.ok(refusal && /seeded only at launch/.test(refusal[0]!), refusal?.join("\n"));
});

test("parsePreviewUnitSpec accepts the launcher's spec and rejects a wrong shape", () => {
  const spec = {
    schemaVersion: 1, id: ID, name: "rev", startArgs: ["--no-risingwave"], withAgentRuns: false,
    createdAt: "2026-11-01T12:00:00Z", deadlineAt: "2026-11-01T14:00:00Z", registryDir: "/r",
    resources: resolvePreviewResources(undefined, undefined),
    owner: { agentId: AGENT, name: "kirby", serverId: null },
    notify: { target: "#triage", messageId: "f85040e1" }, reminderId: null,
    env: { PATH: "/usr/bin" },
  };
  assert.deepEqual(parsePreviewUnitSpec(JSON.stringify(spec)), spec);
  for (const [field, value] of [
    ["id", "x"], ["name", "../x"], ["startArgs", [1]], ["withAgentRuns", "yes"], ["deadlineAt", "soon"],
    ["registryDir", "relative"], ["owner", { name: "" }], ["notify", { target: 1 }], ["env", { A: 1 }],
  ] as const) {
    assert.throws(() => parsePreviewUnitSpec(JSON.stringify({ ...spec, [field]: value })), /invalid preview unit spec/, field);
  }
  assert.throws(() => parsePreviewUnitSpec("not json"));
});

test("previews refuse Docker endpoint overrides, which the cleanup timer could not follow", () => {
  assert.equal(previewDockerEndpointRefusal({ PATH: "/usr/bin" }), null);
  assert.equal(previewDockerEndpointRefusal({ DOCKER_HOST: "" }), null);
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    const refusal = previewDockerEndpointRefusal({ [key]: "x" });
    assert.ok(refusal && refusal[0]!.includes(key), key);
  }
  assert.deepEqual(previewUnitEnv({ PATH: "/usr/bin", DOCKER_HOST: "unix:///d.sock", DOCKER_CONFIG: "/c" }, { withAgentRuns: false }), { PATH: "/usr/bin" });
});
