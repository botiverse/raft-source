import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { BasicTracer, MemoryTraceSink, type CompletedTraceSpan } from "@botiverse/raft-shared";

import { CliExit, inferNextCommands } from "./output.js";
import { ComputerError } from "./lib/errors.js";
import type { LegacyMachineCandidate } from "./lib/types.js";
import { migrationDismissalsPath, serverAttachmentPath, userSessionPath } from "./paths.js";
import { ComputerServiceError } from "./services/errors.js";
import {
  ACCOUNT_UNAVAILABLE_MESSAGES,
  accountUnavailableMessage,
  resolveAccountUnavailableLocale,
} from "./accountUnavailable.js";
import {
  MIGRATION_FRESH_TRIGGERS,
  pickZeroMatchMigrationFromInput,
  pickMigrationCandidateFromInput,
  runSetup as runSetupImpl,
  setupCore,
  type SetupDeps,
  type SetupOptions,
} from "./setup.js";
import { DEFAULT_SLOCK_SERVER_URL, LEGACY_PRODUCTION_SERVER_URL } from "./serverUrl.js";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const SLUG_A = "alpha";
const DEFAULT_USER_SERVERS = [
  { id: SERVER_A, name: "Alpha", slug: SLUG_A, role: "owner" as const },
];

const defaultServersClient = () => ({
  list: async () => ({ status: "success" as const, servers: DEFAULT_USER_SERVERS }),
});

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-setup-"));
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

function findSpan(spans: readonly CompletedTraceSpan[], name: string): CompletedTraceSpan {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `expected span "${name}", got ${spans.map((s) => s.name).join(", ")}`);
  return span;
}

function countOccurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

async function writeSession(
  home: string,
  serverUrl = "https://api.example.test",
  identity: { userId?: string; name?: string; displayName?: string; email?: string } = {},
): Promise<void> {
  const file = userSessionPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      kind: "user-session",
      userId: identity.userId ?? "u-1",
      accessToken: "tok",
      serverUrl,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.email ? { email: identity.email } : {}),
    }),
    { mode: 0o600 },
  );
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

async function writeExpiredSession(home: string, serverUrl = "https://api.example.test"): Promise<void> {
  const file = userSessionPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      kind: "user-session",
      userId: "u-1",
      accessToken: unsignedJwt({ sub: "u-1", type: "access", exp: 1 }),
      refreshToken: "refresh-token",
      serverUrl,
    }),
    { mode: 0o600 },
  );
}

async function writeExpiredSessionWithoutRefresh(home: string, serverUrl = "https://api.example.test"): Promise<void> {
  const file = userSessionPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      kind: "user-session",
      userId: "u-1",
      accessToken: unsignedJwt({ sub: "u-1", type: "access", exp: 1 }),
      serverUrl,
    }),
    { mode: 0o600 },
  );
}

async function writeAttach(home: string, serverId = SERVER_A, serverSlug = SLUG_A, serverUrl = "https://api.example.test"): Promise<void> {
  const file = serverAttachmentPath(home, serverId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverSlug,
      serverMachineId: `cm-${serverId}`,
      apiKey: `sk_computer_${serverId}`,
      serverUrl,
    }),
    { mode: 0o600 },
  );
}

async function treeFingerprint(root: string): Promise<string[]> {
  const rows: string[] = [];
  async function visit(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = join(prefix, entry.name);
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push(`dir:${relative}`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        rows.push(`file:${relative}:${(await readFile(absolute)).toString("base64")}`);
      } else {
        rows.push(`other:${relative}`);
      }
    }
  }
  await visit(root);
  return rows;
}

async function runSetup(opts: SetupOptions, deps: SetupDeps = {}): Promise<void> {
  const buildServersClient =
    deps.buildServersClient ??
    defaultServersClient;
  await runSetupImpl(opts, { ...deps, buildServersClient });
}

async function writeLegacyOwner(
  home: string,
  machineDirName: string,
  apiKeyFingerprint: string,
  hostname = "test-host",
  serverUrl?: string,
): Promise<void> {
  const dir = join(home, "machines", machineDirName, "daemon.lock");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "owner.json"),
    JSON.stringify({
      // pid 999_999_999 is overwhelmingly likely to be dead — keeps the
      // local detection match path active without colliding with any real
      // process tree in the test runner.
      pid: 999_999_999,
      hostname,
      startedAt: new Date().toISOString(),
      apiKeyFingerprint,
      ...(serverUrl ? { serverUrl } : {}),
    }),
  );
}

test("setup: existing login + attachment skips login/attach and starts target server", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          runLogin: async () => { calls.push("login"); },
          runAttach: async () => { calls.push("attach"); },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, [`start:${SERVER_A}`]);
    assert.match(cap.text(), /already logged in/);
    assert.match(cap.text(), /already attached/);
  });
});

test("setup: existing attachment with matching explicit serverUrl starts target server", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home, SERVER_A, SLUG_A, "https://api.example.test");
    const calls: string[] = [];
    await runSetup(
      { serverSlug: "/alpha", serverUrl: "https://api.example.test/", yes: true },
      {
        isTty: false,
        runLogin: async () => { calls.push("login"); },
        runAttach: async () => { calls.push("attach"); },
        runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
      },
    );
    assert.deepEqual(calls, [`start:${SERVER_A}`]);
  });
});

test("setup: legacy production API URL matches an existing canonical attachment", async () => {
  await withHome(async (home) => {
    await writeSession(home, LEGACY_PRODUCTION_SERVER_URL);
    await writeAttach(home, SERVER_A, SLUG_A, DEFAULT_SLOCK_SERVER_URL);
    const calls: string[] = [];
    await runSetup(
      { serverSlug: "/alpha", serverUrl: LEGACY_PRODUCTION_SERVER_URL, yes: true },
      {
        isTty: false,
        runLogin: async () => { calls.push("login"); },
        runAttach: async () => { calls.push("attach"); },
        runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
      },
    );
    assert.deepEqual(calls, [`start:${SERVER_A}`]);
  });
});

test("setup: existing attachment with different explicit serverUrl fails before start", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home, SERVER_A, SLUG_A, "https://api.prod.example.test");
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runSetup(
          { serverSlug: "/alpha", serverUrl: "https://api-aws-staging.botiverse.dev", yes: true },
          {
            isTty: false,
            runAttach: async () => { calls.push("attach"); },
            runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
          },
        ),
        (e) => e instanceof CliExit && e.code === "SETUP_ATTACHMENT_SERVER_URL_MISMATCH",
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, []);
    const text = cap.text();
    assert.match(text, /SETUP_ATTACHMENT_SERVER_URL_MISMATCH/);
    assert.match(text, /https:\/\/api\.prod\.example\.test/);
    assert.match(text, /https:\/\/api-aws-staging\.botiverse\.dev/);
    assert.match(text, /isolated RAFT_HOME/);
    assert.doesNotMatch(text, /SLOCK_HOME/);
  });
});

test("setup: no login in TTY runs login, then attach, then start", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await runSetup(
      { serverSlug: "/alpha" },
      {
        isTty: true,
        runLogin: async () => {
          calls.push("login");
          await writeSession(home);
        },
        runAttach: async () => {
          calls.push("attach");
          await writeAttach(home);
        },
        runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
      },
    );
    assert.deepEqual(calls, ["login", "attach", `start:${SERVER_A}`]);
  });
});

test("setup: expired user session refreshes before attach without browser login", async () => {
  await withHome(async (home) => {
    await writeExpiredSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          refreshUserSession: async () => {
            calls.push("refresh");
            await writeSession(home);
            return true;
          },
          runLogin: async () => {
            calls.push("login");
            await writeSession(home);
          },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["refresh", "attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /Logging in… done \(session refreshed\)\./);
  });
});

test("setup: expired user session with no refresh path in TTY re-runs login before attach", async () => {
  await withHome(async (home) => {
    await writeExpiredSessionWithoutRefresh(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          refreshUserSession: async () => false,
          runLogin: async () => {
            calls.push("login");
            await writeSession(home);
          },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["login", "attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /Logging in… done\./);
  });
});

test("setup: non-TTY without explicit --yes fails closed", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runSetup({ serverSlug: "/alpha" }, { isTty: false }),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NON_INTERACTIVE_SETUP_REQUIRES_FLAGS/);
  });
});

test("setup: account-unavailable target fails through the production guard before any migration/runtime call", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runSetup(
          { serverSlug: "/missing", yes: true },
          {
            isTty: false,
            buildServersClient: () => ({
              list: async () => ({
                status: "success",
                servers: [
                  { id: "server-alpha", name: "Alpha", slug: "alpha", role: "owner" },
                  { id: "server-beta", name: "Beta", slug: "beta", role: "admin" },
                ],
              }),
            }),
            detectLegacyMigration: async () => {
              calls.push("detect");
              return { kind: "no_local_evidence" };
            },
            runAttach: async () => { calls.push("attach"); },
            runStart: async () => { calls.push("start"); },
            buildAccountUnavailableMessage: (input) => {
              calls.push("account-unavailable");
              return accountUnavailableMessage({
                ...input,
                env: { LANG: "en_US.UTF-8" },
                homeDir: dirname(home),
                platform: "linux",
              });
            },
          },
        ),
        (e) => e instanceof CliExit && e.code === "SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT",
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["account-unavailable"]);
    const text = cap.text();
    assert.equal(countOccurrences(text, /^What happened /gm), 1);
    assert.equal(countOccurrences(text, /^Next: /gm), 1);
    assert.equal(countOccurrences(text, /^State: /gm), 1);
    assert.equal(countOccurrences(text, /^Help: /gm), 1);
    assert.match(text, /SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT/);
    assert.match(text, /Server \/missing is not available to the account signed into Computer profile/);
    assert.match(text, /user u-1/);
    assert.match(text, /SLOCK_HOME=.*raft-computer login/);
    assert.match(text, /SLOCK_HOME=.*raft-computer setup '\/missing'/);
    assert.match(text, /https:\/\/app\.raft\.build\/s\/missing\//);
    assert.match(text, /State: No local Computer state change was confirmed by this command\./);
    assert.doesNotMatch(text, /wrong account|belongs to another account/i);
    assert.doesNotMatch(text, /raft-computer logout/);
    assert.doesNotMatch(text, /Migration:/);
  });
});

test("account-unavailable catalogs keep placeholders aligned and fall back to English", () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    placeholders(ACCOUNT_UNAVAILABLE_MESSAGES["zh-cn"].serverUnavailable),
    placeholders(ACCOUNT_UNAVAILABLE_MESSAGES.en.serverUnavailable),
  );
  assert.equal(resolveAccountUnavailableLocale({ LANG: "zh_CN.UTF-8" }), "zh-cn");
  assert.equal(resolveAccountUnavailableLocale({ LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(resolveAccountUnavailableLocale({}), "en");
});

test("account-unavailable copy identifies default/named profiles without exposing email", () => {
  const homeDir = "/home/alice";
  const identity = {
    userId: "11111111-2222-4333-8444-555555555555",
    name: "alice",
    email: "alice-secret@example.test",
  };
  const common = {
    serverLabel: "/project",
    serverSlug: "project",
    identity,
    env: { LANG: "en" },
    homeDir,
    platform: "linux" as const,
  };
  const defaultCopy = accountUnavailableMessage({
    ...common,
    slockHome: "/home/alice/.slock",
  });
  const namedCopy = accountUnavailableMessage({
    ...common,
    slockHome: "/home/alice/.slock/profiles/client-b",
  });
  assert.match(defaultCopy, /profile default \(@alice\)/);
  assert.match(namedCopy, /profile "client-b" \(@alice\)/);
  assert.doesNotMatch(defaultCopy, /alice-secret@example\.test/);
  const command =
    'SLOCK_HOME="$HOME"/\'.slock/profiles/<other-profile>\' raft-computer login && ' +
    'SLOCK_HOME="$HOME"/\'.slock/profiles/<other-profile>\' raft-computer setup \'/project\'';
  assert.ok(defaultCopy.includes(`\`${command}\``));
  assert.ok(namedCopy.includes(`\`${command}\``));
});

test("account-unavailable copy renders zh-cn and a single executable Windows recovery command", () => {
  const copy = accountUnavailableMessage({
    serverLabel: "/项目",
    serverSlug: "项目",
    slockHome: "/home/alice/.slock",
    identity: null,
    env: { LC_ALL: "zh_CN.UTF-8" },
    homeDir: "/home/alice",
    platform: "win32",
  });
  const command =
    "$env:SLOCK_HOME = $HOME + '\\.slock\\profiles\\<other-profile>'; " +
    "raft-computer login; if ($?) { raft-computer setup '/项目' }";
  assert.match(copy, /当前 Computer 配置档 default 登录的账号（当前账号）无法访问服务器 \/项目/);
  assert.ok(copy.includes(`\`${command}\``));
  assert.equal(countOccurrences(copy, /`/g), 2);
  assert.deepEqual(inferNextCommands("SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT", copy), [command]);
  assert.match(copy, /https:\/\/app\.raft\.build\/s\/%E9%A1%B9%E7%9B%AE\//);
});

test("account-unavailable recovery commands preserve adversarial values as literal argv on POSIX and PowerShell", () => {
  const serverLabel = "/missing space'\"$(printf injected)`printf tick`;{}";
  const slockHome = "/custom home/'\"$(printf home-injected)`printf home-tick`;{}";
  const expectedProfileHome = `${slockHome}/profiles/<other-profile>`;
  const common = {
    serverLabel,
    serverSlug: "missing",
    slockHome,
    identity: null,
    env: { LANG: "en" },
    homeDir: "/home/alice",
  };

  const posixCopy = accountUnavailableMessage({ ...common, platform: "linux" });
  const [posixCommand] = inferNextCommands("SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT", posixCopy);
  assert.ok(posixCommand);
  const binDir = mkdtempSync(join(tmpdir(), "raft-computer-command-probe-"));
  const capturePath = join(binDir, "calls.txt");
  const executablePath = join(binDir, "raft-computer");
  try {
    writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        "printf 'home=%s\\n' \"$SLOCK_HOME\" >> \"$RAFT_CAPTURE\"",
        "printf 'argc=%s\\n' \"$#\" >> \"$RAFT_CAPTURE\"",
        "for arg in \"$@\"; do printf 'arg=%s\\n' \"$arg\" >> \"$RAFT_CAPTURE\"; done",
      ].join("\n"),
    );
    chmodSync(executablePath, 0o755);
    const probe = spawnSync("sh", ["-c", posixCommand], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: "/safe/home",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RAFT_CAPTURE: capturePath,
      },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(
      readFileSync(capturePath, "utf8"),
      [
        `home=${expectedProfileHome}`,
        "argc=1",
        "arg=login",
        `home=${expectedProfileHome}`,
        "argc=2",
        "arg=setup",
        `arg=${serverLabel}`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }

  const powerShellCopy = accountUnavailableMessage({ ...common, platform: "win32" });
  const [powerShellCommand] = inferNextCommands(
    "SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT",
    powerShellCopy,
  );
  assert.ok(powerShellCommand);
  const powerShellShape = powerShellCommand.match(
    /^\$env:SLOCK_HOME = ('(?:[^']|'')*'); raft-computer login; if \(\$\?\) \{ raft-computer setup ('(?:[^']|'')*') \}$/,
  );
  assert.ok(powerShellShape, powerShellCommand);
  const decodePowerShellLiteral = (literal: string) =>
    literal.slice(1, -1).replaceAll("''", "'");
  assert.equal(decodePowerShellLiteral(powerShellShape[1]), expectedProfileHome);
  assert.equal(decodePowerShellLiteral(powerShellShape[2]), serverLabel);
  assert.doesNotMatch(powerShellCommand, /powershell\s+-.*-Command/i);
});

for (const [caseName, name] of [
  ["same-account missing membership", "current-account"],
  ["different browser account with no signed intent", "other-account"],
] as const) {
  test(`setup: ${caseName} is the same honest typed outcome and causes zero local/runtime mutation`, async () => {
    await withHome(async (home) => {
      await writeSession(home, "https://api.example.test", { name });
      const runDir = join(home, "computer", "run");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "service.pid"), "4242\n");
      const before = await treeFingerprint(home);
      let thrown: unknown;
      try {
        await setupCore(
          home,
          { serverSlug: "/missing", yes: true },
          {
            isTty: false,
            buildServersClient: () => ({
              list: async () => ({ status: "success", servers: [] }),
            }),
          },
          () => {},
        );
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof ComputerError);
      assert.equal((thrown as ComputerError).code, "SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT");
      assert.match((thrown as ComputerError).message, new RegExp(`@${name}`));
      assert.doesNotMatch((thrown as ComputerError).message, /wrong account|belongs to another account/i);
      assert.deepEqual(await treeFingerprint(home), before);
    });
  });
}

test("setup: malformed server roster response fails closed without misclassifying an account mismatch", async () => {
  await withHome(async (home) => {
    await writeSession(home, "https://api.example.test", { name: "alice" });
    const before = await treeFingerprint(home);
    let thrown: unknown;
    try {
      await setupCore(
        home,
        { serverSlug: "/missing", yes: true },
        {
          isTty: false,
          buildServersClient: () => ({
            list: async () => ({ status: "error", code: "unexpected_shape" }),
          }),
        },
        () => {},
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ComputerError);
    assert.equal((thrown as ComputerError).code, "SETUP_SERVER_LIST_FAILED");
    assert.doesNotMatch((thrown as ComputerError).message, /different account|profile/i);
    assert.deepEqual(await treeFingerprint(home), before);
  });
});

test("setup: member-only target server fails before migration detection", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runSetup(
          { serverSlug: "/alpha", yes: true },
          {
            isTty: false,
            buildServersClient: () => ({
              list: async () => ({
                status: "success",
                servers: [
                  { id: SERVER_A, name: "Alpha", slug: SLUG_A, role: "member" },
                ],
              }),
            }),
            detectLegacyMigration: async () => {
              calls.push("detect");
              return { kind: "no_local_evidence" };
            },
            runAttach: async () => { calls.push("attach"); },
            runStart: async () => { calls.push("start"); },
          },
        ),
        (e) => e instanceof CliExit && e.code === "SETUP_REQUIRES_ADMIN",
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, []);
    const text = cap.text();
    assert.equal(countOccurrences(text, /^What happened /gm), 1);
    assert.equal(countOccurrences(text, /^Next: /gm), 1);
    assert.equal(countOccurrences(text, /^State: /gm), 1);
    assert.equal(countOccurrences(text, /^Help: /gm), 1);
    assert.match(text, /SETUP_REQUIRES_ADMIN/);
    assert.match(text, /requires the admin or owner role/);
    assert.match(text, /only admins\/owners can attach/);
    assert.match(text, /Next: raft-computer setup \/alpha/);
    assert.match(text, /State: No local Computer state change was confirmed by this command\./);
    assert.doesNotMatch(text, /What happened \(SETUP_REQUIRES_ADMIN\): What happened/);
    assert.doesNotMatch(text, /Migration:/);
  });
});

test("setup: future unknown role stays visible but fails closed as non-attachable", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    let thrown: unknown;
    try {
      await setupCore(
        home,
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          buildServersClient: () => ({
            list: async () => ({
              status: "success",
              servers: [
                { id: SERVER_A, name: "Alpha", slug: SLUG_A, role: "observer" },
              ],
            }),
          }),
          detectLegacyMigration: async () => {
            calls.push("detect");
            return { kind: "no_local_evidence" };
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async () => { calls.push("start"); },
        },
        () => {},
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ComputerError);
    assert.equal((thrown as ComputerError).code, "SETUP_REQUIRES_ADMIN");
    assert.deepEqual(calls, []);
  });
});

test("setup: --no-start stops after creating attachment", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    await runSetup(
      { serverSlug: "/alpha", start: false },
      {
        isTty: true,
        runAttach: async () => {
          calls.push("attach");
          await writeAttach(home);
        },
        runStart: async () => { calls.push("start"); },
      },
    );
    assert.deepEqual(calls, ["attach"]);
    const raw = await readFile(serverAttachmentPath(home, SERVER_A), "utf8");
    assert.match(raw, /computer-attachment/);
  });
});

test("setup: forwards orchestrated:true to login/attach to suppress Next hints", async () => {
  await withHome(async (home) => {
    const seen: { login?: boolean; attach?: boolean } = {};
    await runSetup(
      { serverSlug: "/alpha" },
      {
        isTty: true,
        runLogin: async (opts) => {
          seen.login = opts.orchestrated;
          await writeSession(home);
        },
        runAttach: async (opts) => {
          seen.attach = opts.orchestrated;
          await writeAttach(home);
        },
        runStart: async () => { /* no-op */ },
      },
    );
    assert.equal(seen.login, true, "setup must forward orchestrated:true to login");
    assert.equal(seen.attach, true, "setup must forward orchestrated:true to attach");
  });
});

test("setup: orchestrated success output does not contain 'Next: run `raft-computer attach`' or 'Next: run `raft-computer start`'", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          runAttach: async () => { await writeAttach(home); },
          runStart: async () => { /* no-op */ },
        },
      );
    } finally {
      cap.restore();
    }
    const text = cap.text();
    assert.doesNotMatch(text, /Next: run `raft-computer attach/);
    assert.doesNotMatch(text, /Next: run `raft-computer start/);
  });
});

test("setup: successful start keeps the start presenter output", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          runAttach: async () => { await writeAttach(home); },
          runStart: async (opts) => {
            process.stdout.write(`Start presenter: Managing 1 of 1 Computer connection for ${opts?.serverLabel ?? "<missing>"}\n`);
          },
          startService: async () => {
            throw new Error("setup success must use runStart presenter output, not direct startService");
          },
        },
      );
    } finally {
      cap.restore();
    }
    const text = cap.text();
    assert.match(text, /Start presenter: Managing 1 of 1 Computer connection for alpha/);
  });
});

// PR-v9.9 §X.4 — server-roster ∩ local-history picker UX wired into setup.
//
// Coverage anchors:
//   - no local evidence → no picker, fresh attach silent
//   - zero-match local evidence → R2 explain/refuse, or explicit picker/--fresh escape
//   - roster-unavailable → visible warning and explicit/best-effort fresh attach
//   - non-TTY + non-empty intersection → hard-fail with diagnostics
//   - TTY picker → fresh selection → fresh attach
//   - TTY picker → candidate selection → adopt-by-fingerprint invoked with
//     the selected candidate's roster identity
//   - TTY picker → manual path + valid roster match → adopt-by-fingerprint invoked
//   - --machine <machineId> → adopt-by-daemon-id, detection NEVER runs
//   - candidate selected + no legacy api key → adopts via logged-in user
//     roster identity, no LEGACY_KEY_REQUIRED
//   - candidate selected + malformed SLOCK_LEGACY_API_KEY → ignored by setup
//     picker adoption, no LEGACY_KEY_INVALID
//
// The adoption service surface (services/adoptLegacy.test) covers byte-
// level fail-closed; these tests scope the BRANCH choice + dep wiring.

const FP_A = "aaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbb";

function futureExcludedCandidate(path: string, reasons: string[] = ["not_in_roster"]) {
  return {
    evidence: {
      localPath: path,
      ownerState: "missing_fingerprint",
      effectiveFingerprint: FP_A,
      dirFingerprint: FP_A,
      ownerServerUrl: "https://api.raft.build",
      rosterMatch: false,
    },
    reasons,
  };
}

function excludedCandidateForFingerprint(fp: string, reasons: string[] = ["not_in_roster"]) {
  return {
    evidence: {
      localPath: join("/legacy", "machines", `machine-${fp}`, "daemon.lock", "owner.json"),
      ownerState: "ok",
      ownerFingerprint: fp,
      effectiveFingerprint: fp,
      dirFingerprint: fp,
      ownerServerUrl: "https://api.example.test",
      rosterMatch: false,
    },
    reasons,
  };
}

function rosterClientStub(
  entries: Array<{
    daemonId?: string;
    apiKeyFingerprint: string;
    machineName?: string;
    hostname?: string | null;
    lastSeenAt?: string | null;
    legacyKeyMigratedAt?: string | null;
  }>,
) {
  return () => ({
    targetServerUrl: "https://api.example.test",
    list: async () => ({
      status: "success" as const,
      entries: entries.map((e) => ({
        daemonId: e.daemonId ?? `daemon-${e.apiKeyFingerprint}`,
        apiKeyFingerprint: e.apiKeyFingerprint,
        machineName: e.machineName ?? `machine-${e.apiKeyFingerprint.slice(0, 8)}`,
        hostname: e.hostname ?? null,
        lastSeenAt: e.lastSeenAt ?? null,
        legacyKeyMigratedAt: e.legacyKeyMigratedAt ?? null,
      })),
    }),
  });
}

function rosterClientUnavailable() {
  return () => ({
    list: async () => ({ status: "error" as const, code: "request_failed" }),
  });
}

function adoptedResult(home: string, legacyMachineId = `daemon-${FP_A}`) {
  return {
    serverId: SERVER_A,
    serverMachineId: `cm-${SERVER_A}`,
    legacyMachineId,
    serverSlug: SLUG_A,
    serverUrl: "https://api.example.test",
    attachmentPath: serverAttachmentPath(home, SERVER_A),
    resumed: false,
    apiKeyRedactedPrefix: "sk_compu",
    legacyStop: { attempted: false, outcome: "absent" as const },
  };
}

function startResult(home: string) {
  return {
    status: "spawned" as const,
    managedTargets: [SERVER_A],
    attachedCount: 1,
    ready: new Map([[SERVER_A, 1234]]),
    servicePid: 1234,
    serviceLogPath: join(home, "logs", "service.log"),
  };
}

test("setup output: fresh happy path stays within v1.4 five-line budget", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          attachService: async () => {
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: `cm-${SERVER_A}`,
              serverSlug: SLUG_A,
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "sk_compu",
            };
          },
          startService: async () => startResult(home),
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(cap.text().trim().split("\n"), [
      "Logging in… done (already logged in).",
      "Connecting this computer to /alpha… done.",
      "Raft Computer is running. Agents can now use this computer.",
      "Next: chat with your agents at https://app.raft.build/alpha",
      "(check this computer anytime with `raft-computer status`)",
    ]);
  });
});

test("setup output: zero-match defaults to summary and capped server rows", async () => {
  const writes: string[] = [];
  const selection = await pickZeroMatchMigrationFromInput(
    [
      { ownerState: "ok", reasons: ["not_in_roster", "server_url_mismatch"], serverUrlHost: "api.raft.build" },
      { ownerState: "ok", reasons: ["not_in_roster", "server_url_mismatch"], serverUrlHost: "api.raft.build" },
      { ownerState: "absent", reasons: ["not_in_roster"] },
    ],
    Array.from({ length: 6 }, (_, index) => ({
      daemonId: `daemon-${index}`,
      machineName: `old-${index + 1}`,
      hostname: null,
      lastSeenAt: `2026-07-0${Math.min(index + 1, 9)}T00:00:00.000Z`,
      legacyKeyMigratedAt: null,
      hasFingerprint: false,
    })),
    async () => ({ line: "q", eof: false }),
    (line) => { writes.push(line); },
  );
  assert.deepEqual(selection, { kind: "quit" });
  const text = writes.join("");
  assert.match(text, /You can migrate a computer this server already knows/);
  assert.match(text, /\(1 more: type `a` to show all\)/);
  assert.match(text, /Choose 1-5\/a:  \(`new` = set up as a new computer · `q` = quit, nothing changed\)/);
  assert.match(text, /Full evidence: rerun with --verbose/);
  assert.doesNotMatch(text, /Choose \[1\.\.5\/new\/q\]/);
  assert.doesNotMatch(text, /excluded local daemon/);
  assert.doesNotMatch(text, /owner=ok/);
});

test("setup output: zero-match with no server rows does not imply known computers exist", async () => {
  const writes: string[] = [];
  const selection = await pickZeroMatchMigrationFromInput(
    [{ ownerState: "absent", reasons: ["not_in_roster"] }],
    [],
    async () => ({ line: "q", eof: false }),
    (line) => { writes.push(line); },
  );
  assert.deepEqual(selection, { kind: "quit" });
  const text = writes.join("");
  assert.match(text, /No matching computers on this server\. Type new/);
  assert.match(text, /Full evidence: rerun with --verbose/);
  assert.doesNotMatch(text, /You can connect a computer this server already knows/);
});

test("setup output: --verbose local evidence uses human reasons, not internal enums", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true, fresh: true, verbose: true },
        {
          isTty: false,
          detectLegacyMigration: (async () => ({
            kind: "zero_match",
            excluded: [
              {
                evidence: {
                  localPath: join(home, "machines", "machine-other", "daemon.lock", "owner.json"),
                  ownerState: "ok",
                  ownerServerUrl: "https://api.raft.build",
                  rosterMatch: false,
                },
                reasons: ["not_in_roster", "server_url_mismatch"],
              },
              {
                evidence: {
                  localPath: join(home, "machines", "machine-bad", "daemon.lock", "owner.json"),
                  ownerState: "malformed_json",
                  rosterMatch: false,
                },
                reasons: ["owner_malformed"],
              },
              {
                evidence: {
                  localPath: join(home, "machines", "machine-empty"),
                  ownerState: "missing_fingerprint",
                  rosterMatch: false,
                },
                reasons: ["no_fingerprint_evidence"],
              },
            ],
          })) as never,
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => {
            calls.push(`start:${opts?.serverId}`);
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    const text = cap.text();
    assert.match(text, /local daemon .*owner file ok.*belongs to api\.raft\.build/);
    assert.match(text, /local daemon .*owner file malformed.*owner file malformed/);
    assert.match(text, /local daemon .*old daemon format.*old daemon format \(no fingerprint\)/);
    assert.doesNotMatch(text, /not_in_roster|owner_malformed|no_fingerprint_evidence/);
    assert.doesNotMatch(text, /owner=|reasons=|ownerServerHost=/);
  });
});

test("setup output: zero-match Enter re-prompts instead of quitting", async () => {
  const inputs = [
    { line: "", eof: false },
    { line: "q", eof: false },
  ];
  const writes: string[] = [];
  const selection = await pickZeroMatchMigrationFromInput(
    [],
    [],
    async () => inputs.shift() ?? { line: "q", eof: false },
    (line) => { writes.push(line); },
  );
  assert.deepEqual(selection, { kind: "quit" });
  assert.match(writes.join(""), /Type new or q/);
});

test("setup output: zero-match q prints human unchanged line before nonzero exit", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const cap = captureOut();
    try {
      await assert.rejects(
        runSetup(
          { serverSlug: "/alpha" },
          {
            isTty: true,
            detectLegacyMigration: (async () => ({
              kind: "zero_match",
              excluded: [{
                evidence: {
                  localPath: join(home, "machines", "machine-other", "daemon.lock", "owner.json"),
                  ownerState: "ok",
                  ownerServerUrl: "https://api.other.example",
                  rosterMatch: false,
                },
                reasons: ["not_in_roster", "server_url_mismatch"],
              }],
            })) as never,
            buildRosterClient: () => ({
              targetServerUrl: "https://api.example.test",
              list: async () => ({ status: "success" as const, entries: [] }),
              listAll: async () => ({ status: "success" as const, entries: [] }),
            }),
            pickZeroMatchMigration: async () => ({ kind: "quit" }),
          },
        ),
        (err: unknown) => err instanceof CliExit && err.code === "MIGRATION_LOCAL_EVIDENCE_UNMATCHED",
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Nothing was changed\. Run raft-computer setup \/alpha when ready\./);
    assert.match(cap.text(), /\nNext: raft-computer doctor --migration-details\n/);
  });
});

test("setup: unlinked stale runner state is archived and setup re-enters migration picker", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    let startCalls = 0;
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([
            { apiKeyFingerprint: FP_A, machineName: "wenyi-old" },
          ]),
          pickMigrationCandidate: async (candidates) => {
            calls.push(`pick:${candidates.length}`);
            assert.equal(candidates[0]?.apiKeyFingerprint, FP_A);
            return { kind: "candidate", index: 0 };
          },
          adoptLegacyByFingerprint: async () => {
            calls.push("adopt");
            await writeAttach(home);
            return adoptedResult(home);
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async () => {
            startCalls += 1;
            calls.push(`start:${startCalls}`);
            if (startCalls === 1) {
              throw new ComputerServiceError(
                "START_DAEMON_TIMEOUT",
                "Timed out waiting for daemon because computer_machine_unlinked",
              );
            }
          },
        },
      );
    } finally {
      cap.restore();
    }

    assert.deepEqual(calls, ["start:1", "pick:1", "adopt", "start:2"]);
    const attachmentDir = dirname(serverAttachmentPath(home, SERVER_A));
    const names = await readdir(attachmentDir);
    assert.equal(names.filter((name) => /runner\.state\.json\.unlinked-.*\.bak/.test(name)).length, 1);
    assert.ok(names.includes("runner.state.json"));
    assert.match(cap.text(), /archived stale unlinked runner state/);
    assert.match(cap.text(), /returning to the existing Computer picker/);
  });
});

test("setup: adopted connection restarts service when stale running memory reports unlinked", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    let startCalls = 0;
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([
            { apiKeyFingerprint: FP_A, machineName: "wenyi-old" },
          ]),
          pickMigrationCandidate: async () => ({ kind: "candidate", index: 0 }),
          adoptLegacyByFingerprint: async () => {
            calls.push("adopt");
            await writeAttach(home);
            return adoptedResult(home);
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async () => {
            startCalls += 1;
            calls.push(`runStart:${startCalls}`);
            if (startCalls === 1) {
              throw new ComputerServiceError(
                "COMPUTER_MACHINE_UNLINKED",
                "computer_machine_unlinked",
              );
            }
          },
          startService: async () => {
            calls.push("startService");
            return startResult(home);
          },
          stopService: async () => {
            calls.push("stop");
            return { status: "stopped" as const, pid: 1234, pidfilePath: join(home, "service.pid") };
          },
        },
      );
    } finally {
      cap.restore();
    }

    assert.deepEqual(calls, ["adopt", "runStart:1", "stop", "startService"]);
    const attachmentDir = dirname(serverAttachmentPath(home, SERVER_A));
    const names = await readdir(attachmentDir);
    assert.equal(names.filter((name) => name.includes(".unlinked-")).length, 0);
    assert.ok(names.includes("runner.state.json"));
    assert.match(cap.text(), /running service still held the deleted runner in memory/);
  });
});

test("setup output: §1b n exits with human unchanged line", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const cap = captureOut();
    try {
      await assert.rejects(
        runSetup(
          { serverSlug: "/alpha" },
          {
            isTty: true,
            buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
            pickMigrationCandidate: async () => ({ kind: "quit" }),
            runAttach: async () => { throw new Error("attach MUST NOT run after n"); },
          },
        ),
        (err: unknown) => err instanceof CliExit && err.code === "SETUP_CANCELED",
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Nothing was changed\. Run raft-computer setup \/alpha when ready\./);
  });
});

test("setup: §X.4 zero-match local evidence — picker fresh selection proceeds with warning", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A, "test-host", "https://api.other.example");
    const calls: string[] = [];
    let zeroMatchPickerCalled = 0;
    let candidatePickerCalled = 0;
    const diagnosticsCalls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          // Roster has no entry matching FP_A → empty intersection.
          buildRosterClient: rosterClientStub([
            { apiKeyFingerprint: "ffffffffffffffff" },
          ]),
          pickZeroMatchMigration: async (excluded) => {
            zeroMatchPickerCalled += 1;
            assert.equal(excluded.length, 1);
            assert.deepEqual(excluded[0]!.reasons, ["not_in_roster", "server_url_mismatch"]);
            return { kind: "fresh" };
          },
          pickMigrationCandidate: async () => {
            candidatePickerCalled += 1;
            throw new Error("matched-candidate picker MUST NOT fire on zero_match");
          },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
          diagnosticsPush: async (_input, options) => {
            diagnosticsCalls.push(`${options?.trigger}:${options?.forceUploadNow}:${options?.includeComputerTraceRecords}`);
            return { status: "failed", reason: "NO_RUNNER" };
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.equal(zeroMatchPickerCalled, 1, "zero-match local evidence must fire the R2 picker");
    assert.equal(candidatePickerCalled, 0, "zero_match must not use the matched-candidate picker");
    assert.deepEqual(diagnosticsCalls, ["migration:true:true"]);
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /Found 1 trace of old daemons/);
    assert.match(cap.text(), /belongs to other servers/);
    assert.doesNotMatch(cap.text(), /reasons=server_url_mismatch/);
    assert.match(cap.text(), /fresh attach selected after unmatched local legacy evidence/);
    assert.doesNotMatch(cap.text(), /Migration diagnostics: forced upload failed \(NO_RUNNER\)/);
  });
});

test("setup: leading-slash server slug is normalized to bare form before detection/roster (/alpha → alpha)", async () => {
  // Jianwei real-staging FAIL: `setup /alpha` sent `?serverSlug=/alpha` to the
  // legacy-machines roster → 403 → server-unavailable → silent fresh attach.
  // Setup must normalize `/alpha` → `alpha` (the DB slug form) at the entry so
  // detection (and the roster query it builds) see the bare slug.
  await withHome(async (home) => {
    await writeSession(home);
    let detectionSlug: string | null = null;
    let rosterListSlug: string | null = null;
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true },
        {
          isTty: false,
          buildRosterClient: () => ({
            list: async (slug: string) => {
              rosterListSlug = slug;
              return { status: "success" as const, entries: [] };
            },
          }),
          detectLegacyMigration: async (_home, slug) => {
            detectionSlug = slug;
            return { kind: "no_local_evidence" as const };
          },
          runAttach: async () => { await writeAttach(home); },
          runStart: async () => {},
        },
      );
    } finally {
      cap.restore();
    }
    assert.equal(detectionSlug, "alpha", "detection must receive the bare slug, not /alpha");
    // rosterListSlug stays null here (no --machine), but the
    // bare slug detection received is what the real detectLegacyMigration forwards
    // to rosterClient.list — the 403 site. Bare-form normalization at the boundary
    // is the fix.
    assert.equal(rosterListSlug, null);
  });
});

test("setup: --machine with existing attachment hard-fails instead of starting stale identity", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const ownerPath = join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json");
    const calls: string[] = [];

    await assert.rejects(
      () =>
        runSetup(
          { serverSlug: "/alpha", yes: true, machine: "0f0f0f0f-1111-2222-3333-444444444444" },
          {
            isTty: false,
            buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
            adoptLegacyByDaemonId: async () => {
              calls.push("adopt");
              throw new Error("adopt MUST NOT run");
            },
            runStart: async () => {
              calls.push("start");
            },
          },
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "SETUP_MACHINE_ALREADY_ATTACHED");
        return true;
      },
    );

    assert.deepEqual(calls, []);
  });
});

test("setup: §X.4 server-unavailable — info logged, fresh attach proceeds", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientUnavailable(),
          pickRosterUnavailable: async () => ({ kind: "fresh" }),
          pickMigrationCandidate: async () => { throw new Error("picker MUST NOT fire"); },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /Migration: legacy machine roster unavailable/);
  });
});

test("setup: §X.4 non-TTY + non-empty intersection — hard-fails instead of fresh attach", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    const diagnosticsCalls: Array<{ force?: boolean; include?: boolean; attempt?: string; trigger?: string }> = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true },
            {
              isTty: false,
              buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
              pickMigrationCandidate: async () => { throw new Error("picker MUST NOT fire"); },
              runAttach: async () => {
                calls.push("attach");
                await writeAttach(home);
              },
              runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
              diagnosticsPush: async (_input, options) => {
                diagnosticsCalls.push({
                  force: options?.forceUploadNow,
                  include: options?.includeComputerTraceRecords,
                  attempt: options?.migrationAttemptId,
                  trigger: options?.trigger,
                });
                return { status: "failed", reason: "NO_RUNNER" };
              },
            },
          ),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "MIGRATION_CANDIDATE_REQUIRES_INTERACTIVE");
          return true;
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, []);
    assert.equal(diagnosticsCalls.length, 1);
    assert.equal(diagnosticsCalls[0].force, true);
    assert.equal(diagnosticsCalls[0].include, true);
    assert.equal(diagnosticsCalls[0].trigger, "migration");
    assert.match(diagnosticsCalls[0].attempt ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(cap.text(), /Refusing to fresh attach/);
    assert.doesNotMatch(cap.text(), /Migration diagnostics: forced upload failed \(NO_RUNNER\)/);
  });
});

test("setup: §X.4 migration discovery emits candidate count trace including already-migrated rows", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    await assert.rejects(
      () =>
        setupCore(
          home,
          { serverSlug: "/alpha", yes: true },
          {
            isTty: false,
            buildServersClient: defaultServersClient,
            buildRosterClient: rosterClientStub([
              { apiKeyFingerprint: FP_A, legacyKeyMigratedAt: "2026-07-01T00:00:00.000Z" },
            ]),
            runAttach: async () => {
              throw new Error("attach MUST NOT run");
            },
          },
          () => {},
          tracer,
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "MIGRATION_CANDIDATE_REQUIRES_INTERACTIVE");
        return true;
      },
    );

    const span = findSpan(sink.getAllSpans(), "computer.migration.discovery");
    assert.equal(span.status, "ok");
    assert.ok(span.attrs);
    assert.equal(span.attrs.outcome, "matched");
    assert.equal(span.attrs.local_candidate_count, 1);
    assert.equal(span.attrs.matched_count, 1);
    assert.equal(span.attrs.candidate_already_migrated_count, 1);
  });
});

test("setup: zero-match adjudication hard-fails non-TTY unless --fresh is explicit", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const diagnosticsCalls: string[] = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true },
            {
              isTty: false,
              detectLegacyMigration: (async () => ({
                kind: "zero_match",
                excluded: [futureExcludedCandidate(join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json"))],
              })) as never,
              runAttach: async () => {
                calls.push("attach");
              },
              diagnosticsPush: async (_input, options) => {
                diagnosticsCalls.push(`${options?.trigger}:${options?.forceUploadNow}:${options?.includeComputerTraceRecords}`);
                return { status: "failed", reason: "NO_RUNNER" };
              },
            },
          ),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "MIGRATION_LOCAL_EVIDENCE_UNMATCHED");
          return true;
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(diagnosticsCalls, ["migration:true:true"]);
    assert.ok(cap.text().includes(`Using state at ${home}`));
    assert.match(cap.text(), /MIGRATION_LOCAL_EVIDENCE_UNMATCHED/);
    assert.match(cap.text(), /looks like this server but is not recognized/);
    assert.match(cap.text(), /\nNext: raft-computer doctor --migration-details\n/);
    assert.match(cap.text(), /--fresh/);
    assert.doesNotMatch(cap.text(), /missing_fingerprint/);
    assert.doesNotMatch(cap.text(), /not_in_roster/);
    assert.doesNotMatch(cap.text(), /Migration diagnostics: forced upload failed \(NO_RUNNER\)/);
  });
});

test("setup: zero-match --fresh prints summary and proceeds with fresh attach", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true, fresh: true },
        {
          isTty: false,
          detectLegacyMigration: (async () => ({
            kind: "zero_match",
            excluded: [futureExcludedCandidate(join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json"))],
          })) as never,
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => {
            calls.push(`start:${opts?.serverId}`);
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /WARNING: --fresh requested after zero-match evidence/);
    assert.match(cap.text(), /looks like this server but is not recognized/);
    assert.doesNotMatch(cap.text(), /reasons=not_in_roster/);
  });
});

test("setup: zero-match --fresh records dismissed evidence keys after attach commit", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const fp = "1234567890abcdef";
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true, fresh: true },
        {
          isTty: false,
          detectLegacyMigration: (async () => ({
            kind: "zero_match",
            excluded: [excludedCandidateForFingerprint(fp)],
          })) as never,
          runAttach: async () => {
            await writeAttach(home);
          },
          runStart: async () => {},
        },
      );
    } finally {
      cap.restore();
    }

    const raw = await readFile(migrationDismissalsPath(home), "utf8");
    const state = JSON.parse(raw) as {
      schemaVersion?: number;
      dismissals?: Array<{
        kind?: string;
        serverSlug?: string;
        serverUrl?: string;
        evidenceSetKey?: string;
        evidenceKeys?: string[];
        source?: string;
      }>;
    };
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.dismissals?.length, 1);
    assert.equal(state.dismissals?.[0]?.kind, "zero-match-fresh-dismissal");
    assert.equal(state.dismissals?.[0]?.serverSlug, "alpha");
    assert.equal(state.dismissals?.[0]?.serverUrl, "https://api.example.test");
    assert.match(state.dismissals?.[0]?.evidenceSetKey ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(state.dismissals?.[0]?.evidenceKeys, [`fp:${fp}`]);
    assert.equal(state.dismissals?.[0]?.source, "setup --fresh");
    assert.doesNotMatch(raw, /\/legacy\/machines/);
  });
});

test("setup: dismissed zero-match evidence is not asked again, but new evidence still asks", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const fpA = "aaaaaaaaaaaaaaaa";
    const fpB = "bbbbbbbbbbbbbbbb";
    const fpC = "cccccccccccccccc";

    await runSetup(
      { serverSlug: "/alpha", yes: true, fresh: true, start: false },
      {
        isTty: false,
        detectLegacyMigration: (async () => ({
          kind: "zero_match",
          excluded: [excludedCandidateForFingerprint(fpA), excludedCandidateForFingerprint(fpB)],
        })) as never,
        runAttach: async () => {
          await writeAttach(home);
        },
      },
    );

    await rm(join(home, "computer", "servers"), { recursive: true, force: true });

    const capSecond = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true, start: false },
        {
          isTty: false,
          detectLegacyMigration: (async () => ({
            kind: "zero_match",
            excluded: [excludedCandidateForFingerprint(fpA), excludedCandidateForFingerprint(fpB)],
          })) as never,
          runAttach: async () => {
            await writeAttach(home);
          },
        },
      );
    } finally {
      capSecond.restore();
    }
    assert.doesNotMatch(capSecond.text(), /MIGRATION_LOCAL_EVIDENCE_UNMATCHED/);
    assert.doesNotMatch(capSecond.text(), /WARNING: --fresh requested after zero-match evidence/);

    await rm(join(home, "computer", "servers"), { recursive: true, force: true });

    const capThird = captureOut();
    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true },
            {
              isTty: false,
              detectLegacyMigration: (async () => ({
                kind: "zero_match",
                excluded: [
                  excludedCandidateForFingerprint(fpA),
                  excludedCandidateForFingerprint(fpB),
                  excludedCandidateForFingerprint(fpC),
                ],
              })) as never,
              runAttach: async () => {
                await writeAttach(home);
              },
              diagnosticsPush: async () => ({ status: "failed", reason: "NO_RUNNER" }),
            },
          ),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "MIGRATION_LOCAL_EVIDENCE_UNMATCHED");
          return true;
        },
      );
    } finally {
      capThird.restore();
    }
    assert.match(capThird.text(), /Found 1 trace of old daemons/);
    assert.match(capThird.text(), /MIGRATION_LOCAL_EVIDENCE_UNMATCHED/);
  });
});

test("setup: dismissed zero-match evidence never hides a future matched candidate", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const fp = "1234567890abcdef";
    const adoptInputs: string[] = [];

    await runSetup(
      { serverSlug: "/alpha", yes: true, fresh: true, start: false },
      {
        isTty: false,
        detectLegacyMigration: (async () => ({
          kind: "zero_match",
          excluded: [excludedCandidateForFingerprint(fp)],
        })) as never,
        runAttach: async () => {
          await writeAttach(home);
        },
      },
    );

    await rm(join(home, "computer", "servers"), { recursive: true, force: true });

    await runSetup(
      { serverSlug: "/alpha", start: false },
      {
        isTty: true,
        detectLegacyMigration: (async () => ({
          kind: "matched",
          candidates: [{
            apiKeyFingerprint: fp,
            daemonId: "daemon-a",
            localPath: join("/legacy", "machines", `machine-${fp}`, "daemon.lock", "owner.json"),
            machineName: "legacy-a",
          }],
          excluded: [excludedCandidateForFingerprint(fp)],
        })) as never,
        pickMigrationCandidate: async () => ({ kind: "candidate", index: 0 }),
        adoptLegacyByFingerprint: async (input) => {
          adoptInputs.push(input.apiKeyFingerprint);
          await writeAttach(home, SERVER_A, SLUG_A, "https://api.example.test");
          return adoptedResult(home, "daemon-a");
        },
      },
    );

    assert.equal(adoptInputs.length, 1);
    assert.equal(adoptInputs[0], fp);
  });
});

test("setup: zero-match TTY can adopt an includeAll server row by daemonId", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          detectLegacyMigration: (async () => ({
            kind: "zero_match",
            excluded: [futureExcludedCandidate(
              join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json"),
              ["not_in_roster", "server_url_mismatch"],
            )],
          })) as never,
          buildRosterClient: () => ({
            list: async () => ({ status: "success" as const, entries: [] }),
            listAll: async () => ({
              status: "success" as const,
              entries: [
                {
                  daemonId: "daemon-manual-1",
                  machineName: "staging-old-daemon",
                  hostname: "old-host",
                  lastSeenAt: "2026-07-07T00:00:00.000Z",
                  legacyKeyMigratedAt: null,
                  hasFingerprint: false,
                },
              ],
            }),
          }),
          pickZeroMatchMigration: async (_excluded, serverCandidates) => {
            assert.equal(serverCandidates.length, 1);
            assert.equal(serverCandidates[0]?.daemonId, "daemon-manual-1");
            return { kind: "server-candidate", index: 0 };
          },
          adoptLegacyByDaemonId: async (input) => {
            calls.push(`adoptByDaemonId:${input.legacyMachineId}`);
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: `cm-${SERVER_A}`,
              legacyMachineId: input.legacyMachineId,
              serverSlug: SLUG_A,
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "sk_compu",
              legacyStop: { attempted: false, outcome: "absent" },
            };
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["adoptByDaemonId:daemon-manual-1", `start:${SERVER_A}`]);
    assert.doesNotMatch(cap.text(), /apiKeyFingerprint/);
    assert.match(cap.text(), /local owner\.json: not required/);
  });
});

test("setup: matched adjudication prints excluded rows before the picker", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          detectLegacyMigration: (async () => ({
            kind: "matched",
            candidates: [fakeCandidate(1)],
            excluded: [futureExcludedCandidate(join(home, "machines", "machine-bad", "daemon.lock", "owner.json"), ["owner_malformed"])],
          })) as never,
          pickMigrationCandidate: async () => ({ kind: "fresh" }),
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => {
            calls.push(`start:${opts?.serverId}`);
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    const text = cap.text();
    assert.match(text, /some local daemon evidence could not be auto-matched/);
    assert.match(text, /owner file malformed/);
    assert.doesNotMatch(text, /not_in_roster|owner_malformed|no_fingerprint_evidence/);
    assert.doesNotMatch(text, /owner=|reasons=|ownerServerHost=/);
    assert.match(text, /Migration: fresh attach selected/);
  });
});

test("setup: roster-unavailable non-TTY --yes continues fresh with visible warning and trace reason", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const events: string[] = [];

    await setupCore(
      home,
      { serverSlug: "/alpha", yes: true },
      {
        isTty: false,
        buildServersClient: defaultServersClient,
        detectLegacyMigration: (async () => ({ kind: "roster_unavailable", localCount: 2 })) as never,
        runAttach: async () => {
          events.push("attach");
          await writeAttach(home);
        },
        runStart: async (opts) => {
          events.push(`start:${opts?.serverId}`);
        },
      },
      (event) => {
        if (event.kind === "log.line") events.push(event.line);
      },
      tracer,
    );

    assert.deepEqual(events.filter((event) => event === "attach" || event.startsWith("start:")), ["attach", `start:${SERVER_A}`]);
    assert.ok(events.some((event) => event.includes("WARNING: Migration: legacy machine roster unavailable")));
    const decision = findSpan(sink.getAllSpans(), "computer.migration.decision");
    assert.equal(decision.attrs?.reason, "server-unavailable");
    const discovery = findSpan(sink.getAllSpans(), "computer.migration.discovery");
    assert.equal(discovery.attrs?.local_candidate_count, 2);
  });
});

test("setup: migration discovery span redline never emits raw 16-hex fingerprint attrs", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    await assert.rejects(
      () =>
        setupCore(
          home,
          { serverSlug: "/alpha", yes: true },
          {
            isTty: false,
            buildServersClient: defaultServersClient,
            detectLegacyMigration: (async () => ({
              kind: "zero_match",
              excluded: [futureExcludedCandidate(join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json"))],
            })) as never,
            runAttach: async () => {
              throw new Error("attach MUST NOT run");
            },
          },
          () => {},
          tracer,
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "MIGRATION_LOCAL_EVIDENCE_UNMATCHED");
        return true;
      },
    );

    for (const span of sink.getAllSpans()) {
      for (const value of Object.values(span.attrs ?? {})) {
        assert.doesNotMatch(String(value), /^[0-9a-f]{16}$/i, `${span.name} leaked fingerprint attr ${value}`);
      }
    }
  });
});

test("setup: --machine rejects non-UUID input with web pointer (SETUP_MACHINE_INVALID)", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true, machine: "not-a-uuid" },
            {
              isTty: false,
              buildServersClient: defaultServersClient,
              adoptLegacyByDaemonId: async () => {
                calls.push("adopt");
                throw new Error("adopt MUST NOT run on invalid --machine input");
              },
            },
          ),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "SETUP_MACHINE_INVALID");
          return true;
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, []);
    assert.match(cap.text(), /web Computers page/);
    assert.match(cap.text(), /https:\/\/app\.raft\.build\/s\/alpha\/computers/);
  });
});

test("setup: non-TTY zero-match prescription recommends --machine, never --migrate-from", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true },
            {
              isTty: false,
              buildServersClient: defaultServersClient,
              buildRosterClient: rosterClientStub([]),
            },
          ),
        (err: unknown) => (err as { code?: string }).code === "MIGRATION_LOCAL_EVIDENCE_UNMATCHED",
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /--machine <machineId>/);
    assert.doesNotMatch(cap.text(), /--migrate-from/);
  });
});

test("setup: non-TTY + --machine adopts the server row by id (identity-carried entry)", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const ownerPath = join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json");
    const calls: string[] = [];
    const diagnosticsCalls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", yes: true, machine: "0f0f0f0f-1111-2222-3333-444444444444" },
        {
          isTty: false,
          buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
          adoptLegacyByDaemonId: async (_input, options) => {
            options?.onEvent?.({
              type: "adopting",
              serverSlug: "alpha",
              mode: "legacy_daemon_id_roster",
            });
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: "computer-a",
              legacyMachineId: "0f0f0f0f-1111-2222-3333-444444444444",
              serverSlug: "/alpha",
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "12345678",
              legacyStop: { attempted: false, outcome: "absent" },
            };
          },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => {
            calls.push(`start:${opts?.serverId}`);
          },
          diagnosticsPush: async (_input, options) => {
            diagnosticsCalls.push(`${options?.trigger}:${options?.forceUploadNow}:${options?.includeComputerTraceRecords}`);
            calls.push("diagnostics");
            return {
              status: "queued",
              correlationId: "00000000-0000-4000-8000-000000000002",
              expectedWindowSec: 300,
              markerPaths: [],
              uploadResults: [{ serverId: SERVER_A, status: "uploaded", attempted: 1, uploaded: 1 }],
            };
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, [`start:${SERVER_A}`, "diagnostics"]);
    assert.deepEqual(diagnosticsCalls, ["migration:true:true"]);
    assert.match(cap.text(), /via server machine identity/);
    assert.doesNotMatch(cap.text(), /legacy_daemon_id_roster/);
    assert.match(cap.text(), /WARNING: legacy daemon stop was NOT verified/);
    assert.match(cap.text(), /OS service/);
    assert.match(cap.text(), /raft-computer doctor \/alpha/);
  });
});

test("setup: §X.4 migration adoption emits resume and legacy-stop trace attrs", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const ownerPath = join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json");
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });

    await setupCore(
      home,
      { serverSlug: "/alpha", yes: true, machine: "0f0f0f0f-1111-2222-3333-444444444444", start: false },
      {
        isTty: false,
        buildServersClient: defaultServersClient,
        buildRosterClient: rosterClientStub([
          { apiKeyFingerprint: FP_A, legacyKeyMigratedAt: "2026-07-01T00:00:00.000Z" },
        ]),
        adoptLegacyByDaemonId: async () => {
          await writeAttach(home);
          return {
            serverId: SERVER_A,
            serverMachineId: "computer-a",
            legacyMachineId: "0f0f0f0f-1111-2222-3333-444444444444",
            serverSlug: "/alpha",
            serverUrl: "https://api.example.test",
            attachmentPath: serverAttachmentPath(home, SERVER_A),
            resumed: true,
            apiKeyRedactedPrefix: "12345678",
            legacyStop: { attempted: true, outcome: "stopped", pid: 123 },
          };
        },
      },
      () => {},
      tracer,
    );

    const span = findSpan(sink.getAllSpans(), "computer.migration.adopt");
    assert.equal(span.status, "ok");
    assert.ok(span.attrs);
    // --machine carries no roster context, so already-migrated is unknown
    // (false) at span start; resume truth arrives via the adoption result.
    assert.equal(span.attrs.candidate_already_migrated, false);
    assert.equal(span.attrs.resumed, true);
    assert.equal(span.attrs.legacy_stop_outcome, "stopped");
  });
});

test("setup: §X.4 migration adoption failure forces scrubbed diagnostics before surfacing error", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const ownerPath = join(home, "machines", "machine-aaaaaaaaaaaaaaaa", "daemon.lock", "owner.json");
    const diagnosticsCalls: Array<{ force?: boolean; include?: boolean; attempt?: string; trigger?: string }> = [];
    const cap = captureOut();

    try {
      await assert.rejects(
        () =>
          runSetup(
            { serverSlug: "/alpha", yes: true, machine: "0f0f0f0f-1111-2222-3333-444444444444", start: false },
            {
              isTty: false,
              buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
              adoptLegacyByDaemonId: async () => {
                throw new ComputerServiceError("LEGACY_DAEMON_STOP_FAILED", "legacy stop failed");
              },
              diagnosticsPush: async (_input, options) => {
                diagnosticsCalls.push({
                  force: options?.forceUploadNow,
                  include: options?.includeComputerTraceRecords,
                  attempt: options?.migrationAttemptId,
                  trigger: options?.trigger,
                });
                return { status: "failed", reason: "NO_RUNNER" };
              },
            },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CliExit);
          assert.equal((err as CliExit).code, "LEGACY_DAEMON_STOP_FAILED");
          return true;
        },
      );
    } finally {
      cap.restore();
    }

    assert.equal(diagnosticsCalls.length, 1);
    assert.equal(diagnosticsCalls[0].force, true);
    assert.equal(diagnosticsCalls[0].include, true);
    assert.equal(diagnosticsCalls[0].trigger, "migration");
    assert.match(diagnosticsCalls[0].attempt ?? "", /^[0-9a-f-]{36}$/i);
    const output = cap.text();
    assert.ok(output.includes(`Using state at ${home}`));
    assert.match(output, /What happened \(LEGACY_DAEMON_STOP_FAILED\): legacy stop failed/);
    assert.match(output, /legacy stop failed/);
    assert.match(output, /Next: raft-computer setup \/<server>/);
    assert.match(output, /State: Setup stopped before changing local Computer state\./);
    assert.doesNotMatch(output, /Migration diagnostics: forced upload failed \(NO_RUNNER\)/);
  });
});

test("setup: §X.4 picker fresh — typed-new selection → fresh attach", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    let pickerCalls = 0;
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
          pickMigrationCandidate: async () => { pickerCalls += 1; return { kind: "fresh" }; },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.equal(pickerCalls, 1, "picker must fire once on non-empty intersection + TTY");
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.match(cap.text(), /Migration: fresh attach selected/);
  });
});

test("setup: §X.4 picker candidate — selection N → adopt-by-fingerprint invoked with that candidate", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    await writeLegacyOwner(home, "machine-bbbbbbbbbbbbbbbb", FP_B);
    const calls: string[] = [];
    const adoptInputs: Array<{
      serverSlug: string;
      legacyMachineId: string;
      apiKeyFingerprint: string;
      legacyOwnerPath: string;
    }> = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([
            { apiKeyFingerprint: FP_A, machineName: "alice-laptop" },
            { apiKeyFingerprint: FP_B, machineName: "bob-laptop" },
          ]),
          pickMigrationCandidate: async (candidates) => {
            // Pick whichever one corresponds to FP_B so we exercise the
            // index→candidate plumbing rather than the trivial 0th case.
            const idx = candidates.findIndex((c) => c.apiKeyFingerprint === FP_B);
            return { kind: "candidate", index: idx };
          },
          adoptLegacyByFingerprint: async (input) => {
            calls.push("adoptByFingerprint");
            adoptInputs.push({
              serverSlug: input.serverSlug,
              legacyMachineId: input.legacyMachineId,
              apiKeyFingerprint: input.apiKeyFingerprint,
              legacyOwnerPath: input.legacyOwnerPath,
            });
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: `cm-${SERVER_A}`,
              legacyMachineId: "legacy-1",
              serverSlug: SLUG_A,
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "sk_compu",
              legacyStop: { attempted: false, outcome: "absent" },
            };
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, ["adoptByFingerprint", `start:${SERVER_A}`], "adopt branch must skip fresh attach");
    assert.equal(adoptInputs.length, 1);
    // Normalized to the bare DB slug form at the setup entry — the server
    // adopt endpoint expects the same bare slug the roster does ("/alpha"
    // would 403 there too).
    assert.equal(adoptInputs[0]!.serverSlug, "alpha");
    assert.equal(adoptInputs[0]!.legacyMachineId, `daemon-${FP_B}`);
    assert.equal(adoptInputs[0]!.apiKeyFingerprint, FP_B);
    assert.match(adoptInputs[0]!.legacyOwnerPath, /machine-bbbbbbbbbbbbbbbb/);
    assert.match(cap.text(), /adopting legacy daemon "bob-laptop"/);
    assert.match(cap.text(), /legacy api key: not required/);
    assert.match(cap.text(), /WARNING: legacy daemon stop was NOT verified/);
    assert.match(cap.text(), /launchd\/systemd\/service wrapper/);
    assert.match(cap.text(), /raft-computer doctor \/alpha/);
  });
});

// §X.4 post-Jianwei FAIL `msg=ecc2e57e` — interactive `m` failures must
// loop back to the picker (only the flag form hard-fails on
// validation errors).
test("setup: §X.4 picker candidate + missing legacy api key → adopts without LEGACY_KEY_REQUIRED", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
          pickMigrationCandidate: async () => ({ kind: "candidate", index: 0 }),
          adoptLegacyByFingerprint: async (input) => {
            calls.push(`adoptByFingerprint:${input.apiKeyFingerprint}`);
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: `cm-${SERVER_A}`,
              legacyMachineId: input.legacyMachineId,
              serverSlug: SLUG_A,
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "sk_compu",
              legacyStop: { attempted: false, outcome: "absent" },
            };
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(calls, [`adoptByFingerprint:${FP_A}`, `start:${SERVER_A}`]);
    assert.doesNotMatch(cap.text(), /LEGACY_KEY_REQUIRED/);
    assert.match(cap.text(), /legacy api key: not required/);
  });
});

test("setup: §X.4 picker candidate + malformed SLOCK_LEGACY_API_KEY → ignores raw key and adopts by fingerprint", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeLegacyOwner(home, "machine-aaaaaaaaaaaaaaaa", FP_A);
    const oldLegacyKey = process.env.SLOCK_LEGACY_API_KEY;
    process.env.SLOCK_LEGACY_API_KEY = "not-a-legacy-key";
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: rosterClientStub([{ apiKeyFingerprint: FP_A }]),
          pickMigrationCandidate: async () => ({ kind: "candidate", index: 0 }),
          adoptLegacyByFingerprint: async (input) => {
            calls.push(`adoptByFingerprint:${input.apiKeyFingerprint}`);
            await writeAttach(home);
            return {
              serverId: SERVER_A,
              serverMachineId: `cm-${SERVER_A}`,
              legacyMachineId: input.legacyMachineId,
              serverSlug: SLUG_A,
              serverUrl: "https://api.example.test",
              attachmentPath: serverAttachmentPath(home, SERVER_A),
              resumed: false,
              apiKeyRedactedPrefix: "sk_compu",
              legacyStop: { attempted: false, outcome: "absent" },
            };
          },
          runAttach: async () => { calls.push("attach"); },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
      if (oldLegacyKey === undefined) delete process.env.SLOCK_LEGACY_API_KEY;
      else process.env.SLOCK_LEGACY_API_KEY = oldLegacyKey;
    }
    assert.deepEqual(calls, [`adoptByFingerprint:${FP_A}`, `start:${SERVER_A}`]);
    assert.doesNotMatch(cap.text(), /LEGACY_KEY_INVALID/);
    assert.match(cap.text(), /legacy api key: not required/);
  });
});

test("setup: §X.4 fresh-fallback — no local owners at all, no roster fetch, fresh attach", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const calls: string[] = [];
    let factoryCalls = 0;
    let listCalls = 0;
    let pickerCalls = 0;
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: () => {
            factoryCalls += 1;
            return {
              list: async () => {
                listCalls += 1;
                return { status: "success", entries: [] };
              },
            };
          },
          pickMigrationCandidate: async () => { pickerCalls += 1; return { kind: "fresh" }; },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }
    // No local owners → detection short-circuits before hitting roster.
    assert.equal(factoryCalls, 0, "roster factory MUST stay lazy when no local evidence exists");
    assert.equal(listCalls, 0, "roster MUST NOT be hit when no local evidence exists");
    assert.equal(pickerCalls, 0, "no candidates → no picker");
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.doesNotMatch(cap.text(), /Migration:/);
  });
});

test("setup: v2 managed owner skips roster factory and list before fresh attach", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    await writeAttach(home, SERVER_B, "beta");
    const apiKey = `sk_computer_${SERVER_B}`;
    const fp = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    const lockDir = join(home, "machines", `machine-${fp}`, "daemon.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      schemaVersion: 2,
      kind: "managed_computer_runner",
      serverId: SERVER_B,
      serverMachineId: `cm-${SERVER_B}`,
      pid: 999_999_999,
      hostname: "managed-host",
      startedAt: new Date().toISOString(),
      apiKeyFingerprint: fp,
      serverUrl: "https://api.example.test",
    }));

    let factoryCalls = 0;
    let listCalls = 0;
    const calls: string[] = [];
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha" },
        {
          isTty: true,
          buildRosterClient: () => {
            factoryCalls += 1;
            return {
              list: async () => {
                listCalls += 1;
                return { status: "success", entries: [] };
              },
            };
          },
          runAttach: async () => {
            calls.push("attach");
            await writeAttach(home);
          },
          runStart: async (opts) => { calls.push(`start:${opts?.serverId}`); },
        },
      );
    } finally {
      cap.restore();
    }

    assert.equal(factoryCalls, 0, "v2 managed owner must be classified before roster construction");
    assert.equal(listCalls, 0, "v2 managed owner must never call roster list");
    assert.deepEqual(calls, ["attach", `start:${SERVER_A}`]);
    assert.doesNotMatch(cap.text(), /zero-match|duplicate an existing legacy daemon/i);
  });
});

test("setup: --no-start retains explicit Start: skipped hint (not regressed by orchestrated suppression)", async () => {
  await withHome(async (home) => {
    await writeSession(home);
    const cap = captureOut();
    try {
      await runSetup(
        { serverSlug: "/alpha", start: false },
        {
          isTty: true,
          runAttach: async () => { await writeAttach(home); },
          runStart: async () => { /* no-op */ },
        },
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Start: skipped \(--no-start\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Picker grammar (Cody NIT `msg=9102a817` + Jianwei FAIL `msg=ecc2e57e`)
// ───────────────────────────────────────────────────────────────────────
//
// These tests exercise `pickMigrationCandidateFromInput` directly so the
// grammar is locked independent of runSetup's surrounding wiring. The
// closed-set fresh triggers are validated separately:
//
//   - typed-new: typed `new` here
//   - eof: stdin closed (`eof: true`)
//   - non-tty: runSetup test above (line ~440)
//   - empty-intersection: runSetup test above (line ~370)
//   - server-unavailable: runSetup test above (line ~410)
//
// Negative coverage:
//   - `<Enter>` with candidates → NOT fresh and NOT candidate (reprompts)
//   - invalid input → NOT fresh (reprompts; tested via a multi-line stub)

function fakeCandidate(
  n: number,
  opts: { machineName?: string; hostname?: string | null; lastSeenAt?: string | null; legacyKeyMigratedAt?: string | null } = {},
): LegacyMachineCandidate {
  return {
    machineName: opts.machineName ?? `machine-${n}`,
    daemonId: `daemon-${n}`,
    apiKeyFingerprint: `${n}`.repeat(16),
    localPath: `/tmp/legacy-${n}`,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    ...(opts.lastSeenAt ? { lastSeenAt: opts.lastSeenAt } : {}),
    ...(opts.legacyKeyMigratedAt ? { legacyKeyMigratedAt: opts.legacyKeyMigratedAt } : {}),
  };
}

function scriptedReader(lines: Array<{ line: string; eof?: boolean }>) {
  let i = 0;
  return async () => {
    const next = lines[i];
    if (!next) throw new Error(`scriptedReader exhausted at index ${i}`);
    i += 1;
    return { line: next.line, eof: next.eof === true };
  };
}

test("picker grammar: closed-set fresh triggers tuple matches RFC §X.4", () => {
  // Sentinel — if anyone adds/renames a trigger without updating the RFC
  // or the contract chips, this test goes red.
  assert.deepEqual(
    [...MIGRATION_FRESH_TRIGGERS],
    ["empty-intersection", "typed-new", "eof", "non-tty", "server-unavailable", "zero-match-explicit-fresh"],
  );
});

test("picker grammar: typing `new` → fresh (typed-new)", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1, { lastSeenAt: "2 minutes ago" }), fakeCandidate(2, { lastSeenAt: "2 minutes ago" })],
    scriptedReader([{ line: "new" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "fresh" });
  assert.match(out, /Found 2 old daemons on this computer that can migrate to \/alpha:/);
  assert.match(out, /1\. machine-1 — last seen/);
  assert.match(out, /2\. machine-2 — last seen/);
  assert.match(out, /← most recent/);
  assert.match(out, /Type 1-2 to migrate one \(keeps its agents · new = separate computer · q = quit\)/);
  assert.match(out, /Choose:/);
  assert.doesNotMatch(out, /Found at:/);
  assert.doesNotMatch(out, /Press Enter/);
});

test("picker grammar: unique legacy daemon asks Migrate y/n/new and Enter re-prompts", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1, { lastSeenAt: "2 hours ago" })],
    scriptedReader([{ line: "" }, { line: "y" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "candidate", index: 0 });
  assert.match(out, /Found this computer's previous setup \(old Raft daemon\):/);
  assert.match(out, /  ● machine-1 — last seen 2 hours ago/);
  assert.match(out, /Migrate it to Raft Computer\? \[y\/n\]  \(keeps your agents · `new` = set up separately\)/);
  assert.doesNotMatch(out, /set up separately\)\nMigrate it to Raft Computer/);
  assert.doesNotMatch(out, /Migrate\? \[y\/n\/new\]/);
  assert.match(out, /`new` = set up separately/);
  assert.match(out, /Pressing Enter does not choose an action here/);
});

test("picker grammar: unique old Computer asks Reconnect y/n and n quits", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1, { lastSeenAt: "2 hours ago", legacyKeyMigratedAt: "2026-07-01T00:00:00.000Z" })],
    scriptedReader([{ line: "n" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "quit" });
  assert.match(out, /This computer was connected to \/alpha before:/);
  assert.match(out, /  ● machine-1 — last seen 2 hours ago/);
  assert.match(out, /Reconnect\? \[y\/n\]/);
  assert.doesNotMatch(out, /Found this computer's previous setup \(Raft Computer\):/);
  assert.doesNotMatch(out, /Reconnect\? \[y\/n\]\nReconnect\? \[y\/n\]:/);
  assert.doesNotMatch(out, /set up separately/);
});

test("picker grammar: typing `0` is invalid and does NOT fresh attach", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2)],
    scriptedReader([{ line: "0" }, { line: "1" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "candidate", index: 0 });
  assert.match(out, /Invalid selection "0"/);
  assert.match(out, /Type 1\.\.2, new, or q/);
});

test("picker grammar: EOF → fresh (eof trigger), no further reads", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2)],
    scriptedReader([{ line: "", eof: true }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "fresh" });
});

test("picker grammar: Enter with candidates reprompts instead of choosing candidate #1", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2)],
    scriptedReader([{ line: "" }, { line: "2" }]),
    (s) => { out += s; },
  );
  assert.deepEqual(sel, { kind: "candidate", index: 1 });
  assert.match(out, /Pressing Enter does not choose an action here/);
});

test("picker grammar: `2` → candidate #2 (1-indexed)", async () => {
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2), fakeCandidate(3)],
    scriptedReader([{ line: "2" }]),
    () => {},
  );
  assert.deepEqual(sel, { kind: "candidate", index: 1 });
});

test("picker grammar: invalid input reprompts (NOT fresh, NOT candidate)", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2)],
    scriptedReader([{ line: "banana" }, { line: "9" }, { line: "1" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "candidate", index: 0 });
  assert.match(out, /Invalid selection "banana"/);
  assert.match(out, /Invalid selection "9"/);
  assert.match(out, /Type 1\.\.2, new, or q/);
});

test("picker grammar: out-of-range numeric reprompts (NOT silent fresh)", async () => {
  let out = "";
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1)],
    scriptedReader([{ line: "5" }, { line: "new" }]),
    (s) => {
      out += s;
    },
  );
  assert.deepEqual(sel, { kind: "fresh" });
  assert.match(out, /Invalid selection "5"/);
});

test("picker grammar: whitespace-only input reprompts", async () => {
  // `   ` trims to empty → Enter semantics → reprompt (NOT fresh, NOT candidate).
  // Sanity-check that trimming happens before the empty-string branch.
  const sel = await pickMigrationCandidateFromInput(
    "/alpha",
    [fakeCandidate(1), fakeCandidate(2)],
    scriptedReader([{ line: "   " }, { line: "1" }]),
    () => {},
  );
  assert.deepEqual(sel, { kind: "candidate", index: 0 });
});

test("picker grammar: duplicate candidate display names get fp8 disambiguators without local paths", async () => {
  let out = "";
  await pickMigrationCandidateFromInput(
    "/alpha",
    [
      fakeCandidate(1, { machineName: "desert-flute", hostname: "desert-flute", lastSeenAt: "2 minutes ago" }),
      fakeCandidate(2, { machineName: "desert-flute", hostname: "desert-flute", lastSeenAt: "2 minutes ago" }),
    ],
    scriptedReader([{ line: "new" }]),
    (s) => {
      out += s;
    },
  );
  assert.match(out, /1\. desert-flute \(11111111…\) — last seen 2 minutes ago/);
  assert.match(out, /2\. desert-flute \(22222222…\) — last seen 2 minutes ago/);
  assert.doesNotMatch(out, /desert-flute \(desert-flute\)/);
  assert.doesNotMatch(out, /Found at:/);
});
