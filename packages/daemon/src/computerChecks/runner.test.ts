import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDaemonLogs } from "../logger";
import { fakeSpawn } from "../testing/fakeCheckSpawn";
import { observeOwnerChecksSwitch, readOwnerChecksSwitch, type OwnerChecksSwitch } from "./ownerSwitch";
import { CHECK_REPORT_MAX_BYTES, runComputerChecks } from "./runner";
import { isStoredPluginValid } from "./storedRows";
import { COMPUTER_CHECK_IDS, type CheckItem, type ComputerCheck, type ComputerCheckId } from "./types";

const FAKE_GH_TOKEN = "gho_FAKE0123456789abcdefFAKE";
const FAKE_NPM_TOKEN = "npm_FAKE0123456789abcdefghijFAKE";
const FAKE_AWS_SECRET = "FAKEawsSecretAccessKey0123456789abcdef";
const NOTHING_OFF: OwnerChecksSwitch = { disabled: new Set() };
const ALL_ON = Object.fromEntries(COMPUTER_CHECK_IDS.map((id) => [id, true])) as Record<ComputerCheckId, boolean>;

let home: string;
let logs: string[];
let unsubscribe: () => void;

async function put(relative: string, text: string) {
  await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
  await writeFile(path.join(home, relative), text);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "computer-checks-"));
  logs = [];
  unsubscribe = subscribeDaemonLogs((event) => logs.push(event.line, String(event.error ?? "")));
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  unsubscribe();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function plugin(report: Awaited<ReturnType<typeof runComputerChecks>>, id: ComputerCheckId) {
  return report.plugins.find((p) => p.id === id);
}

describe("runComputerChecks with the v1 checks", () => {
  it("reports logins, registry and token presence but never a token, in the report or the logs", async () => {
    await put(".config/gh/hosts.yml", [
      "github.com:",
      "    users:",
      "        octocat:",
      `            oauth_token: ${FAKE_GH_TOKEN}`,
      `    oauth_token: ${FAKE_GH_TOKEN}`,
      "    user: octocat",
      "    git_protocol: ssh",
    ].join("\n"));
    await put(".npmrc", [
      "registry=https://ci:hunter2@npm.example.com/?authtoken=abc",
      `//npm.example.com/:_authToken=${FAKE_NPM_TOKEN}`,
    ].join("\n"));
    await put(".aws/config", "[default]\nregion = us-west-2\n[profile dev]\nregion = not-a-region!\n");
    await put(".aws/credentials", `[default]\naws_access_key_id = AKIAFAKE0123456789AB\naws_secret_access_key = ${FAKE_AWS_SECRET}\n`);
    await put(".config/gcloud/active_config", "work\n");
    await put(".config/gcloud/configurations/config_work", "[core]\naccount = alice.example@example.com\nproject = demo\n");
    const fake = fakeSpawn({
      "gh --version": { stdout: "gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1\n" },
      "git config --global user.name": { stdout: "Alice Example\n" },
      "git config --global user.email": { stdout: "alice.example@example.com\n" },
      "node --version": { stdout: "v24.3.0\n" },
      "npm --version": { stdout: "11.4.2\n" },
      "docker --version": { stdout: "Docker version 27.1.1, build 6312585\n" },
      "vercel --version": "hang",
    });

    const report = await runComputerChecks(ALL_ON, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: { PATH: "/usr/bin", HOME: home, GITHUB_TOKEN: FAKE_GH_TOKEN, NPM_TOKEN: FAKE_NPM_TOKEN },
      owner: NOTHING_OFF,
      spawn: fake.spawn,
      commandTimeoutMs: 100,
    });

    const json = JSON.stringify(report);
    for (const secret of [FAKE_GH_TOKEN, FAKE_NPM_TOKEN, FAKE_AWS_SECRET, "AKIAFAKE", "hunter2", "authtoken=abc", "alice.example@"]) {
      expect(json).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    for (const call of fake.calls) {
      expect(JSON.stringify(call.env)).not.toContain("FAKE");
      expect(call.cwd).toBe(path.join(home, "cwd"));
    }

    expect(report.plugins.map((p) => p.id)).toEqual([...COMPUTER_CHECK_IDS]);
    expect(plugin(report, "github")?.items).toEqual([
      { key: "gh.version", label: "GitHub CLI", value: "2.40.1", status: "ok" },
      { key: "github.account:github.com", label: "GitHub account (github.com)", value: "octocat", status: "local" },
      { key: "git.user.name", label: "Git commit name", value: "Alice Example", displayText: true, status: "local" },
      { key: "git.user.email", label: "Git commit email", value: "ali****ample@example.com", status: "local" },
    ]);
    expect(plugin(report, "node")?.items).toEqual([
      { key: "node.version", label: "Node.js", value: "24.3.0", status: "ok" },
      { key: "pnpm.version", label: "pnpm", status: "not_installed" },
      { key: "npm.version", label: "npm", value: "11.4.2", status: "ok" },
    ]);
    expect(plugin(report, "docker")?.items).toEqual([{ key: "docker.version", label: "Docker", value: "27.1.1", status: "ok" }]);
    expect(plugin(report, "gcloud")?.items).toEqual([
      { key: "gcloud.config", label: "gcloud configuration", value: "work", status: "local" },
      { key: "gcloud.account", label: "gcloud account", value: "ali****ample@example.com", status: "local" },
    ]);
    expect(plugin(report, "aws")?.items).toEqual([
      { key: "aws.profile:default", label: "AWS profile (default)", value: "us-west-2", status: "local" },
      { key: "aws.profile:dev", label: "AWS profile (dev)", status: "local" },
    ]);
    expect(plugin(report, "npm")?.items).toEqual([
      { key: "npm.registry", label: "npm registry", value: "https://npm.example.com", status: "local" },
      { key: "npm.auth", label: "npm sign-in", value: "token saved", status: "local" },
    ]);
    expect(plugin(report, "stamp")?.items).toEqual([{ key: "stamp.version", label: "Stamp CLI", status: "not_installed" }]);
    // A command past its 5 s limit (100 ms here) is shown, unconfirmed.
    expect(plugin(report, "vercel")?.items).toEqual([{ key: "vercel.version", label: "Vercel CLI", status: "unconfirmed", reason: "timeout" }]);
    // What the checks emit is what a round read back from the shared round file must look like (storedRows.ts).
    for (const p of report.plugins) expect(isStoredPluginValid(p), p.id).toBe(true);
  });

  it("drops a git user.name with invisible characters and a flood of digits from gh", async () => {
    const fake = fakeSpawn({
      "gh --version": { stdout: `gh version 1.${"9".repeat(64 * 1024 - 100)}\n` },
      "git config --global user.name": { stdout: "Ali\u200bce\u{E0041}\n" },
    });
    const started = performance.now();
    const report = await runComputerChecks({ github: true }, { homeDir: home, workDir: path.join(home, "cwd"), parentEnv: {}, owner: NOTHING_OFF, spawn: fake.spawn });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(plugin(report, "github")?.items).toEqual([{ key: "gh.version", label: "GitHub CLI", status: "unconfirmed", reason: "failed" }]);
  });

  it("reports a corrupt gh hosts.yml as parse_failed without its content, in the report or the logs", async () => {
    await put(".config/gh/hosts.yml", `github.com:\n\tuser: octocat\n\toauth_token: ${FAKE_GH_TOKEN}\n`);
    await put(".npmrc", `${FAKE_NPM_TOKEN}\n`);

    const report = await runComputerChecks({ github: true, npm: true }, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: {},
      owner: NOTHING_OFF,
      spawn: fakeSpawn({}).spawn,
    });

    expect(plugin(report, "github")?.items).toContainEqual({ key: "github.accounts", label: "GitHub accounts", status: "unconfirmed", reason: "parse_failed" });
    expect(plugin(report, "npm")?.items).toEqual([{ key: "npm.config", label: "npm config", status: "unconfirmed", reason: "parse_failed" }]);
    const json = JSON.stringify(report);
    expect(json).not.toContain(FAKE_GH_TOKEN);
    expect(json).not.toContain(FAKE_NPM_TOKEN);
    expect(json).not.toContain("octocat");
    expect(logs.join("\n")).not.toContain("FAKE");
  });
});

describe("runComputerChecks round rules", () => {
  const fixed = (id: ComputerCheckId, run: ComputerCheck["run"]): ComputerCheck => ({ id, commands: [], files: [], run });

  it("marks a check that outlives the round budget unconfirmed instead of dropping it", async () => {
    const report = await runComputerChecks({ docker: true, node: true }, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: {},
      owner: NOTHING_OFF,
      roundBudgetMs: 100,
      checks: [
        fixed("docker", () => new Promise<CheckItem[]>(() => {})),
        fixed("node", async () => [{ key: "node.version", label: "Node.js", value: "24.0.0", status: "ok" }]),
      ],
    });

    expect(report.plugins).toEqual([
      expect.objectContaining({ id: "docker", error: "timeout", items: [{ key: "docker.check", label: "docker", status: "unconfirmed", reason: "timeout" }] }),
      expect.objectContaining({ id: "node", items: [{ key: "node.version", label: "Node.js", value: "24.0.0", status: "ok" }] }),
    ]);
  });

  it("marks a check that throws unconfirmed and logs no error text", async () => {
    const report = await runComputerChecks({ aws: true }, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: {},
      owner: NOTHING_OFF,
      checks: [fixed("aws", async () => {
        throw new Error(`boom ${FAKE_AWS_SECRET}`);
      })],
    });

    expect(report.plugins[0]).toMatchObject({ id: "aws", error: "failed", items: [{ status: "unconfirmed", reason: "failed" }] });
    expect(logs.join("\n")).toContain("check aws failed");
    expect(logs.join("\n")).not.toContain(FAKE_AWS_SECRET);
  });

  it("lets the owner's local switch override what the server enabled", async () => {
    const ran: ComputerCheckId[] = [];
    const checks = (["aws", "npm", "docker"] as const).map((id) => fixed(id, async () => {
      ran.push(id);
      return [{ key: `${id}.x`, label: id, status: "ok" }];
    }));
    await mkdir(path.join(home, "computer"), { recursive: true });
    await writeFile(path.join(home, "computer/checks.json"), JSON.stringify({ disabled: ["aws", "not-a-check"] }));

    const owner = await readOwnerChecksSwitch(home);
    const report = await runComputerChecks({ aws: true, npm: true, docker: false }, { homeDir: home, workDir: path.join(home, "cwd"), parentEnv: {}, owner, checks });

    expect(ran).toEqual(["npm"]);
    expect(report.plugins).toEqual([
      { id: "aws", items: [], durationMs: 0, disabledByOwner: true },
      expect.objectContaining({ id: "npm", items: [{ key: "npm.x", label: "npm", status: "ok" }] }),
    ]);

    await writeFile(path.join(home, "computer/checks.json"), JSON.stringify({ disabled: "all" }));
    const allOff = await runComputerChecks({ aws: true, npm: true }, { homeDir: home, workDir: path.join(home, "cwd"), parentEnv: {}, owner: await readOwnerChecksSwitch(home), checks });
    expect(allOff.plugins.every((p) => p.disabledByOwner === true)).toBe(true);
    expect(ran).toEqual(["npm"]);
  });

  it("reads a missing owner switch as nothing off and an unreadable one as everything off", async () => {
    expect(await readOwnerChecksSwitch(home)).toEqual({ disabled: new Set() });
    await mkdir(path.join(home, "computer"), { recursive: true });
    await writeFile(path.join(home, "computer/checks.json"), `{"disabled": [${JSON.stringify(FAKE_AWS_SECRET)}`);
    expect(await readOwnerChecksSwitch(home)).toEqual({ disabled: "all" });
    expect(logs.join("\n")).not.toContain(FAKE_AWS_SECRET);
  });

  it.skipIf(process.platform === "win32")("treats an owner switch replaced by a FIFO as unreadable (all off) without hanging", async () => {
    await mkdir(path.join(home, "computer"), { recursive: true });
    execFileSync("mkfifo", [path.join(home, "computer/checks.json")]);
    const started = Date.now();
    expect(await readOwnerChecksSwitch(home)).toEqual({ disabled: "all" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("treats an owner switch over 4 KB as unreadable (all off)", async () => {
    await mkdir(path.join(home, "computer"), { recursive: true });
    await writeFile(path.join(home, "computer/checks.json"), JSON.stringify({ disabled: [], pad: "x".repeat(5000) }));
    expect(await readOwnerChecksSwitch(home)).toEqual({ disabled: "all" });
  });

  it("reports the owner switch and when it last changed, across rounds", async () => {
    let clock = Date.parse("2026-11-19T10:00:00.000Z");
    const now = () => clock;
    const switchFile = path.join(home, "computer/checks.json");
    const round = async () => {
      const owner = await readOwnerChecksSwitch(home);
      const ownerSwitch = await observeOwnerChecksSwitch(home, owner, now);
      return runComputerChecks({ aws: true }, { homeDir: home, workDir: path.join(home, "cwd"), parentEnv: {}, owner, ownerSwitch, checks: [fixed("aws", async () => [])], now });
    };

    // First sighting: the state, no change claimed.
    expect((await round()).ownerSwitch).toEqual({ disabled: [] });
    clock += 60_000;
    expect((await round()).ownerSwitch).toEqual({ disabled: [] });

    await mkdir(path.dirname(switchFile), { recursive: true });
    await writeFile(switchFile, JSON.stringify({ disabled: "all" }));
    clock += 60_000;
    const off = await round();
    expect(off.ownerSwitch).toEqual({ disabled: "all", previous: [], changedAt: "2026-11-19T10:02:00.000Z" });
    expect(off.plugins).toEqual([{ id: "aws", items: [], durationMs: 0, disabledByOwner: true }]);

    // Unchanged: the last change stays visible.
    clock += 60_000;
    expect((await round()).ownerSwitch).toEqual({ disabled: "all", previous: [], changedAt: "2026-11-19T10:02:00.000Z" });

    // Removed (say by an agent running as the same user): reported as back on, and when.
    await rm(switchFile);
    clock += 60_000;
    expect((await round()).ownerSwitch).toEqual({ disabled: [], previous: "all", changedAt: "2026-11-19T10:04:00.000Z" });

    await writeFile(switchFile, JSON.stringify({ disabled: ["npm", "aws"] }));
    clock += 60_000;
    expect((await round()).ownerSwitch).toEqual({ disabled: ["aws", "npm"], previous: [], changedAt: "2026-11-19T10:05:00.000Z" });

    // A corrupt record is a first sighting again, not a claimed change.
    await writeFile(path.join(home, "computer/checks-switch-seen.json"), "{not json");
    clock += 60_000;
    expect((await round()).ownerSwitch).toEqual({ disabled: ["aws", "npm"] });
  });

  it("runs no command when the work directory is not an empty real directory, and says so distinctly (not installed / failed)", async () => {
    const checks = [
      { id: "docker" as const, commands: [["docker", "--version"]], files: [], run: async () => [{ key: "docker.x", label: "docker", status: "ok" as const }] },
      fixed("aws", async () => [{ key: "aws.x", label: "aws", status: "local" }]),
    ];
    const failed = { id: "docker", items: [{ key: "docker.check", label: "docker", status: "unconfirmed", reason: "run_folder_unavailable" }], durationMs: 0, error: "run_folder_unavailable" };
    const nonEmpty = path.join(home, "cwd-planted");
    await mkdir(nonEmpty, { recursive: true });
    await writeFile(path.join(nonEmpty, "package.json"), "{}");
    const target = path.join(home, "elsewhere");
    await mkdir(target);
    const linked = path.join(home, "cwd-link");
    await symlink(target, linked, "dir");

    for (const workDir of [nonEmpty, linked]) {
      const report = await runComputerChecks({ docker: true, aws: true }, { homeDir: home, workDir, parentEnv: {}, owner: NOTHING_OFF, checks });
      expect(report.plugins).toEqual([failed, expect.objectContaining({ id: "aws", items: [{ key: "aws.x", label: "aws", status: "local" }] })]);
    }
    expect(logs.join("\n")).toContain("work directory is not an empty directory");

    const ok = await runComputerChecks({ docker: true }, { homeDir: home, workDir: path.join(home, "cwd-fresh"), parentEnv: {}, owner: NOTHING_OFF, checks });
    expect(ok.plugins[0]).toMatchObject({ id: "docker", items: [{ key: "docker.x", status: "ok" }] });
  });

  it("caps rows per check and the report's size, and marks both", async () => {
    const rows = (id: string, n: number, value: string): CheckItem[] =>
      Array.from({ length: n }, (_, i) => ({ key: `${id}.${i}`, label: id, value, status: "ok" }));
    const report = await runComputerChecks(ALL_ON, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: {},
      owner: NOTHING_OFF,
      checks: COMPUTER_CHECK_IDS.map((id) => fixed(id, async () => rows(id, 25, "v".repeat(120)))),
    });

    expect(report.plugins[0]).toMatchObject({ truncated: true });
    expect(report.plugins[0]?.items).toHaveLength(20);
    expect(report.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(CHECK_REPORT_MAX_BYTES);
  });

  it("scrubs credential shapes from every string as the last step", async () => {
    const report = await runComputerChecks({ vercel: true }, {
      homeDir: home,
      workDir: path.join(home, "cwd"),
      parentEnv: {},
      owner: NOTHING_OFF,
      checks: [fixed("vercel", async () => [{ key: "vercel.x", label: `label ${FAKE_GH_TOKEN}`, value: `ghp_${"A".repeat(36)}`, status: "ok" }])],
    });

    expect(JSON.stringify(report)).not.toMatch(/gho_FAKE|ghp_A/);
    expect(report.plugins[0]?.items[0]).toEqual({ key: "vercel.x", label: "label ***REDACTED***", value: "***REDACTED***", status: "ok" });
  });
});
