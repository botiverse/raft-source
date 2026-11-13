// Reconciler step 15 (B7 / B8 / B9): a credential held invalid is released
// when it changes on disk, as a web login releases it. Real ledger, real
// files in a temp home; the check is called directly (the timer only calls it).
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptConfig } from "./testing/promptFixture";
import { CredentialDiskWatch, SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS, type CredentialDiskWatchDeps } from "./credentialDiskWatch";
import { claudeKeychainService, NODE_CREDENTIAL_FS, securityCommandEnv, type CredentialFs, type SecurityCommandRunner } from "./credentialSource";
import { ProviderLimitLedger, type ProviderLimitCredentialKey } from "./providerLimitLedger";
import { writeKimiStoredToken } from "./runtimeAccountUsage/kimiTokenRefresh";
import type { AgentConfig } from "@botiverse/raft-shared";

let home: string;
const watches: CredentialDiskWatch[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "raft-credential-disk-watch-"));
});

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
  rmSync(home, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A later mtime, so a rewrite is seen by `stat` even on a coarse clock. */
function bumpMtime(file: string, seconds = 10): void {
  const at = new Date(Date.now() + seconds * 1000);
  utimesSync(file, at, at);
}

type Events = Array<{ name: string; attrs: Record<string, unknown> }>;

function setup(overrides: Partial<CredentialDiskWatchDeps> = {}) {
  const ledger = new ProviderLimitLedger();
  const events: Events = [];
  const timers = { set: 0, cleared: 0, live: false };
  const watch = new CredentialDiskWatch({
    ledger,
    recordEvent: (name, attrs) => { events.push({ name, attrs }); },
    baseEnv: () => ({}),
    homeDir: home,
    platform: "linux",
    cwd: home,
    setInterval: () => { timers.set += 1; timers.live = true; return { id: timers.set }; },
    clearInterval: () => { timers.cleared += 1; timers.live = false; },
    ...overrides,
  });
  watches.push(watch);
  const hold = (key: ProviderLimitCredentialKey, config?: AgentConfig) =>
    ledger.recordInvalid(key, { invalidReason: "user_reauth", recordedAtMs: Date.now() }, { host: "legacy", agentId: "agent-1" }, config);
  return { ledger, events, timers, watch, hold };
}

const sharedCodexAuth = () => path.join(home, ".codex", "auth.json");
const releases = (events: Events) => events.filter((event) => event.name === "daemon.credential.disk_change_release");

test("a held shared Codex credential whose auth.json is rewritten is released with credentials_changed within one check", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"old\"}}");
  const { ledger, events, watch, hold } = setup();
  const released: string[] = [];
  ledger.subscribe((change) => { if (change.kind === "invalid_released") released.push(change.cause); });
  hold("shared:codex");

  await watch.check();
  expect(ledger.hasInvalid("shared:codex"), "unchanged: still held").toBe(true);

  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"new\"}}");
  bumpMtime(sharedCodexAuth());
  await watch.check();

  expect(ledger.hasInvalid("shared:codex")).toBe(false);
  expect(released).toEqual(["credentials_changed"]);
  expect(releases(events)).toHaveLength(1);
  const attrs = releases(events)[0]!.attrs;
  expect(attrs).toEqual({
    runtime: "codex",
    credential_key_kind: "shared",
    source_kind: "file",
    release_cause: "credentials_changed",
    credential_invalid_released: 1,
    credential_invalid_reason: "user_reauth",
  });
  // Never a path (a home path can hold a user name), a digest or content.
  expect(JSON.stringify(attrs)).not.toContain(home);
  expect(JSON.stringify(attrs)).not.toMatch(/[0-9a-f]{32}/u);
});

test("the same bytes rewritten (a touch) do not release: the stat changed, the content did not", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"same\"}}");
  const { ledger, watch, hold } = setup();
  hold("shared:codex");
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"same\"}}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  expect(ledger.hasInvalid("shared:codex")).toBe(true);
});

test("a deleted credential file (a logout) does not release", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{}}");
  const { ledger, watch, hold } = setup();
  hold("shared:codex");
  unlinkSync(sharedCodexAuth());
  await watch.check();
  expect(ledger.hasInvalid("shared:codex")).toBe(true);
});

test("a sign-in after the record found no file releases (absent, then present)", async () => {
  const { ledger, watch, hold } = setup();
  hold("shared:codex");
  await watch.check();
  write(sharedCodexAuth(), "{\"tokens\":{}}");
  await watch.check();
  expect(ledger.hasInvalid("shared:codex")).toBe(false);
});

test("a provider-limit hold is not released by a disk change (Q-3), and alone it starts no check", async () => {
  write(sharedCodexAuth(), "{\"v\":1}");
  const { ledger, watch, timers, hold } = setup();
  const limit = { attempts: 1, reason: "quota", untilMs: Date.now() + 60_000, providerLimitKind: "quota_exhausted" as const, recordedAtMs: Date.now() };
  ledger.record("shared:codex", limit, { host: "legacy", agentId: "agent-1" });
  expect(watch.running, "a limit alone is not watched").toBe(false);
  expect(timers.set).toBe(0);

  hold("shared:codex");
  write(sharedCodexAuth(), "{\"v\":2}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  expect(ledger.hasInvalid("shared:codex"), "the invalid record is released").toBe(false);
  expect(ledger.get("shared:codex", Date.now()), "the limit stays").toMatchObject({ reason: "quota" });
});

test("an agent with its own CODEX_HOME (B8) is watched there, not in the shared home", async () => {
  const ownHome = path.join(home, "agent-codex");
  write(path.join(ownHome, "auth.json"), "{\"v\":1}");
  write(sharedCodexAuth(), "{\"v\":1}");
  const { ledger, watch, hold } = setup();
  hold("agent:agent-1", promptConfig({ envVars: { CODEX_HOME: ownHome } }));

  write(sharedCodexAuth(), "{\"v\":2}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  expect(ledger.hasInvalid("agent:agent-1"), "a change in the shared home is not its credential").toBe(true);

  write(path.join(ownHome, "auth.json"), "{\"v\":2}");
  bumpMtime(path.join(ownHome, "auth.json"));
  await watch.check();
  expect(ledger.hasInvalid("agent:agent-1")).toBe(false);
});

test("an own credential recorded without the agent's config is not watched (its source is unknown)", () => {
  const { watch, hold } = setup();
  hold("agent:agent-1");
  expect(watch.watchedCount).toBe(0);
  expect(watch.running).toBe(false);
});

test("the check timer runs only while something is held, and nothing is read when nothing is", async () => {
  write(sharedCodexAuth(), "{\"v\":1}");
  const reads: string[] = [];
  const fs: CredentialFs = {
    statSync: (target) => { reads.push(target); return NODE_CREDENTIAL_FS.statSync(target); },
    readFileSync: (target) => { reads.push(target); return NODE_CREDENTIAL_FS.readFileSync(target); },
    readdirSync: (target) => { reads.push(target); return NODE_CREDENTIAL_FS.readdirSync(target); },
  };
  const { ledger, watch, timers, hold } = setup({ fs });
  await watch.check();
  expect(reads, "nothing held: no stat").toEqual([]);
  expect(watch.running).toBe(false);

  hold("shared:codex");
  expect(watch.running).toBe(true);
  expect(timers).toMatchObject({ set: 1, live: true });

  // Released another way (a web login): the timer stops with the ledger empty.
  ledger.releaseInvalid("shared:codex", "credentials_changed", { host: "legacy" });
  expect(watch.running).toBe(false);
  expect(timers).toMatchObject({ cleared: 1, live: false });
  reads.length = 0;
  await watch.check();
  expect(reads).toEqual([]);
});

test("macOS Claude: the Keychain item's modification date, read with attributes only (never -w or -g)", async () => {
  const calls: string[][] = [];
  let mdat = "0x32303236313130383035313735355A00";
  const runSecurity: SecurityCommandRunner = async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: `keychain: "/Users/x/Library/Keychains/login.keychain-db"\nattributes:\n    "mdat"<timedate>=${mdat}  "20261108051755Z\\000"\n` };
  };
  const { ledger, watch, hold, events } = setup({ platform: "darwin", runSecurity });
  hold("shared:claude");
  await watch.check();
  expect(ledger.hasInvalid("shared:claude")).toBe(true);

  mdat = "0x32303236313130383036303030305A00";
  await watch.check();
  expect(ledger.hasInvalid("shared:claude")).toBe(false);
  expect(releases(events)[0]!.attrs).toMatchObject({ runtime: "claude", source_kind: "keychain,file" });
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) {
    expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials"]);
    expect(args).not.toContain("-w");
    expect(args).not.toContain("-g");
  }
});

test("macOS Claude with CLAUDE_CONFIG_DIR: the service is suffixed with the dir's hash", () => {
  expect(claudeKeychainService({})).toBe("Claude Code-credentials");
  expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/srv/claude-1" })).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/u);
  expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/srv/claude-1" })).not.toBe(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/srv/claude-2" }));
});

test("macOS Claude: a missing Keychain item (exit 44) does not release", async () => {
  let code = 0;
  const runSecurity: SecurityCommandRunner = async () => ({ code, stdout: code === 0 ? "    \"mdat\"<timedate>=0x01  \"x\"\n" : "" });
  const { ledger, watch, hold } = setup({ platform: "darwin", runSecurity });
  hold("shared:claude");
  await watch.check();
  code = 44;
  await watch.check();
  expect(ledger.hasInvalid("shared:claude")).toBe(true);
});

test("Linux Claude: <CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json", async () => {
  const file = path.join(home, ".claude", ".credentials.json");
  write(file, "{\"claudeAiOauth\":{\"accessToken\":\"a\"}}");
  const { ledger, watch, hold } = setup();
  hold("shared:claude");
  write(file, "{\"claudeAiOauth\":{\"accessToken\":\"b\"}}");
  bumpMtime(file);
  await watch.check();
  expect(ledger.hasInvalid("shared:claude")).toBe(false);
});

test("Qoder: a change in the config directory releases (its credential file name is not known)", async () => {
  const dir = path.join(home, ".qoder");
  write(path.join(dir, "settings.json"), "{}");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const { ledger, watch, hold } = setup();
  hold("shared:qoder");

  // A file written inside a subdirectory (a log) is not a sign-in.
  write(path.join(dir, "logs", "today.log"), "line");
  await watch.check();
  expect(ledger.hasInvalid("shared:qoder")).toBe(true);

  write(path.join(dir, "auth"), "token");
  await watch.check();
  expect(ledger.hasInvalid("shared:qoder")).toBe(false);
});

test("Grok (B9): an agent's own record is watched in $GROK_HOME/auth.json", async () => {
  const grokHome = path.join(home, "grok-home");
  write(path.join(grokHome, "auth.json"), "{\"v\":1}");
  const { ledger, watch, hold } = setup();
  hold("agent:agent-1", promptConfig({ runtime: "grok", envVars: { GROK_HOME: grokHome } }));
  write(path.join(grokHome, "auth.json"), "{\"v\":2}");
  bumpMtime(path.join(grokHome, "auth.json"));
  await watch.check();
  expect(ledger.hasInvalid("agent:agent-1")).toBe(false);
});

test("Kimi: the daemon's own token write is not a sign-in; the user's is", async () => {
  const credentials = path.join(home, ".kimi-code", "credentials");
  const file = path.join(credentials, "kimi-code.json");
  write(file, "{\"access_token\":\"a\"}");
  const { ledger, watch, hold } = setup();
  hold("shared:kimi");

  writeKimiStoredToken(file, { access_token: "b", refresh_token: "r", expires_at: 1, expires_in: 1, scope: "", token_type: "Bearer" });
  bumpMtime(file);
  writeKimiStoredToken(file, { access_token: "c", refresh_token: "r", expires_at: 2, expires_in: 1, scope: "", token_type: "Bearer" });
  await watch.check();
  expect(ledger.hasInvalid("shared:kimi"), "the daemon's refresh rewrote it").toBe(true);

  write(path.join(credentials, "kimi-code.json"), "{\"access_token\":\"user\"}");
  bumpMtime(file, 30);
  await watch.check();
  expect(ledger.hasInvalid("shared:kimi")).toBe(false);
});

test("a runtime not in the table is not covered", () => {
  const { watch, hold } = setup();
  hold("agent:agent-1", promptConfig({ runtime: "gemini" }));
  expect(watch.watchedCount).toBe(0);
});

test("the Keychain read gets a minimal environment: no runtime keys or Raft tokens", () => {
  const env = securityCommandEnv({
    PATH: "/usr/bin:/bin", HOME: "/Users/someone", USER: "someone", LOGNAME: "someone", TMPDIR: "/tmp/x/",
    ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-secret", RAFT_AGENT_TOKEN: "sk_agent_secret", SLOCK_MACHINE_KEY: "sk_computer_secret",
  });
  assert.deepEqual(env, { PATH: "/usr/bin:/bin", HOME: "/Users/someone", USER: "someone", LOGNAME: "someone", TMPDIR: "/tmp/x/" });
  assert.deepEqual(securityCommandEnv({ HOME: "/h" }), { HOME: "/h" }, "absent names stay absent");
});

// ── PR 3: the shared homes (a server pause no held record knows of) ────────

function sharedSetup(overrides: Partial<CredentialDiskWatchDeps> = {}) {
  const changes: string[] = [];
  let nowMs = 1_000_000;
  const base = setup({
    onSharedCredentialsChanged: (runtime) => { changes.push(runtime); },
    now: () => nowMs,
    ...overrides,
  });
  return { ...base, changes, advance: (ms: number) => { nowMs += ms; } };
}

const sharedChanges = (events: Events) => events.filter((event) => event.name === "daemon.credential.shared_disk_change");

test("PR 3: a shared Codex auth.json rewritten reports the runtime once; no change reports nothing", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"old\"}}");
  const { watch, changes, events } = sharedSetup();
  watch.setSharedHomes(["codex"]);
  watch.setSharedHomesActive(true);
  expect(watch.running).toBe(true);
  expect(watch.sharedRuntimes).toEqual(["codex"]);

  await watch.check();
  expect(changes, "unchanged since the watch began").toEqual([]);

  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"new\"}}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  expect(changes).toEqual(["codex"]);
  await watch.check();
  expect(changes, "the same new state is not a second change").toEqual(["codex"]);

  const attrs = sharedChanges(events)[0]!.attrs;
  expect(attrs).toEqual({ runtime: "codex", credential_key_kind: "shared", source_kind: "file" });
  expect(JSON.stringify(sharedChanges(events))).not.toContain(home);
  expect(JSON.stringify(sharedChanges(events))).not.toMatch(/[0-9a-f]{32}/u);
});

test("PR 3: a deleted file (logout) or the same bytes (touch) report nothing; a sign-in after a logout does", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"same\"}}");
  const { watch, changes } = sharedSetup();
  watch.setSharedHomes(["codex"]);
  watch.setSharedHomesActive(true);
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"same\"}}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  unlinkSync(sharedCodexAuth());
  await watch.check();
  expect(changes).toEqual([]);
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"fresh\"}}");
  await watch.check();
  expect(changes).toEqual(["codex"]);
});

test("PR 3: the shared homes are not checked while inactive or empty: no timer, no stat", async () => {
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"old\"}}");
  let stats = 0;
  const countingFs: CredentialFs = { ...NODE_CREDENTIAL_FS, statSync: (target) => { stats += 1; return NODE_CREDENTIAL_FS.statSync(target); } };
  const { watch, changes } = sharedSetup({ fs: countingFs });

  watch.setSharedHomesActive(true);
  expect(watch.running, "active with nothing to watch").toBe(false);

  watch.setSharedHomesActive(false);
  watch.setSharedHomes(["codex"]);
  expect(watch.running, "inactive (no server reads the change)").toBe(false);
  expect(watch.sharedRuntimes).toEqual([]);
  const afterBaseline = stats;
  write(sharedCodexAuth(), "{\"tokens\":{\"access_token\":\"new\"}}");
  bumpMtime(sharedCodexAuth());
  await watch.check();
  expect(stats, "an inactive check stats nothing").toBe(afterBaseline);
  expect(changes).toEqual([]);

  // Active again (the server reconnected): the change made meanwhile is seen against the last state.
  watch.setSharedHomesActive(true);
  expect(watch.running).toBe(true);
  await watch.check();
  expect(changes).toEqual(["codex"]);

  watch.setSharedHomes([]);
  expect(watch.running).toBe(false);
});

test("PR 3: changes inside the gap are reported once when it ends (a churning source costs one status query per gap)", async () => {
  write(sharedCodexAuth(), "{\"v\":0}");
  const { watch, changes, advance } = sharedSetup();
  watch.setSharedHomes(["codex"]);
  watch.setSharedHomesActive(true);
  for (let v = 1; v <= 3; v += 1) {
    write(sharedCodexAuth(), `{"v":${v}}`);
    bumpMtime(sharedCodexAuth(), 10 * v);
    await watch.check();
    advance(30_000);
  }
  expect(changes).toEqual(["codex"]);
  advance(SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS);
  await watch.check();
  expect(changes, "the pending change, once the gap ended").toEqual(["codex", "codex"]);
  advance(SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS);
  await watch.check();
  expect(changes, "nothing pending").toEqual(["codex", "codex"]);
});

test("PR 3: the daemon's own Kimi token write is not a sign-in in the shared home either", async () => {
  const credentials = path.join(home, ".kimi-code", "credentials");
  const file = path.join(credentials, "kimi-code.json");
  write(file, "{\"access_token\":\"a\"}");
  const { watch, changes } = sharedSetup();
  watch.setSharedHomes(["kimi"]);
  watch.setSharedHomesActive(true);
  writeKimiStoredToken(file, { access_token: "b", refresh_token: "r", expires_at: 1, expires_in: 1, scope: "", token_type: "Bearer" });
  await watch.check();
  expect(changes).toEqual([]);
  write(file, "{\"access_token\":\"user\"}");
  bumpMtime(file, 30);
  await watch.check();
  expect(changes, "a user's sign-in is").toEqual(["kimi"]);
});

test("PR 3: macOS Claude's shared Keychain item is read by attributes only; its new mdat reports a change", async () => {
  let mdat = "0x32303236313130383130303030305A00";
  const argv: string[][] = [];
  const runSecurity: SecurityCommandRunner = async (args) => {
    argv.push([...args]);
    return { code: 0, stdout: `keychain: "/Users/x/Library/Keychains/login.keychain-db"\n    "mdat"<timedate>=${mdat}  "20261108100000Z\\000"\n` };
  };
  const { watch, changes } = sharedSetup({ platform: "darwin", runSecurity });
  watch.setSharedHomes(["claude"]);
  watch.setSharedHomesActive(true);
  await watch.check();
  expect(changes).toEqual([]);
  mdat = "0x32303236313130383130303530305A00";
  await watch.check();
  expect(changes).toEqual(["claude"]);
  expect(argv.every((args) => args.join(" ") === `find-generic-password -s ${claudeKeychainService({})}`)).toBe(true);
});
