import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KillTreeOptions } from "../runtimeDetectionRound";
import { fakeSpawn } from "../testing/fakeCheckSpawn";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { checkChildEnv, commandSlots, createCheckContext, DECLARED_FILE_MAX_BYTES, killCheckTree, type CheckChildProcess, type CheckSpawn } from "./context";
import { readDeclaredKeys } from "./declaredFile";
import { awsProfileSectionShape, awsRegionShape, displayNameShape, githubLoginShape, hostnameShape, presenceShape, registryUrlShape, versionShape } from "./shapes";
import type { ComputerCheck, DeclaredFile } from "./types";

const FAKE_GH_TOKEN = "gho_FAKE0123456789abcdefFAKE";
const FAKE_NPM_TOKEN = "npm_FAKE0123456789abcdefghijFAKE";

function contextFor(check: Pick<ComputerCheck, "id" | "commands" | "files">, overrides: Partial<Parameters<typeof createCheckContext>[1]> = {}) {
  return createCheckContext(check, {
    homeDir: "/nonexistent-home",
    workDir: os.tmpdir(),
    parentEnv: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    slots: commandSlots(3),
    ...overrides,
  });
}

describe("CheckContext.exec", () => {
  it("refuses an argv the check did not declare, without spawning", async () => {
    const fake = fakeSpawn({ "gh --version": { stdout: "gh version 2.40.1" } });
    const ctx = contextFor({ id: "github", commands: [["gh", "--version"]], files: [] }, { spawn: fake.spawn });

    await expect(ctx.exec(["gh", "auth", "token"])).rejects.toThrow(/not declared/);
    await expect(ctx.exec(["gh", "--version", "--extra"])).rejects.toThrow(/not declared/);
    await expect(ctx.exec(["gh"])).rejects.toThrow(/not declared/);
    expect(fake.calls).toEqual([]);

    await expect(ctx.exec(["gh", "--version"])).resolves.toEqual({ stdout: "gh version 2.40.1", exitCode: 0 });
  });

  it("gives the child only PATH, LANG, LC_*, HOME set to the service home, and the no-prompt switches, in the fixed cwd", async () => {
    const printEnv = [process.execPath, "-e", "process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }))"];
    const workDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "computer-checks-cwd-")));
    const parentEnv = {
      PATH: process.env.PATH,
      HOME: "/home/someone-else",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      RAFT_TOKEN: "sk_machine_FAKE0123456789",
      SLOCK_SERVER_URL: "https://raft.example",
      SLOCK_MACHINE_API_KEY: "sk_machine_FAKEFAKE0123",
      AWS_SECRET_ACCESS_KEY: "FAKEawsSecretAccessKey0123456789",
      GITHUB_TOKEN: FAKE_GH_TOKEN,
      NODE_OPTIONS: "--no-deprecation",
      GH_PROMPT_DISABLED: "0",
      COREPACK_ENABLE_NETWORK: "1",
    };
    try {
      const ctx = contextFor({ id: "node", commands: [printEnv], files: [] }, { parentEnv, homeDir: "/home/computer", workDir });

      const result = await ctx.exec(printEnv);

      expect(result).toMatchObject({ exitCode: 0 });
      const child = JSON.parse((result as { stdout: string }).stdout) as { env: Record<string, string>; cwd: string };
      const expected = {
        PATH: process.env.PATH,
        HOME: "/home/computer",
        LANG: "en_US.UTF-8",
        LC_ALL: "C.UTF-8",
        GH_PROMPT_DISABLED: "1",
        NO_UPDATE_NOTIFIER: "1",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        CI: "1",
        COREPACK_ENABLE_NETWORK: "0",
        VERCEL_TELEMETRY_DISABLED: "1",
      };
      expect(checkChildEnv(parentEnv, "/home/computer")).toEqual(expected);
      if (process.platform === "win32") {
        // libuv adds SYSTEMROOT & co. to every Windows child (see context.ts).
        expect(child.env).toMatchObject(expected);
        expect(JSON.stringify(child.env)).not.toMatch(/FAKE|raft\.example/);
      } else {
        expect(child.env).toEqual(expected);
      }
      expect(await realpath(child.cwd)).toBe(workDir);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("finds PATH under any case on Windows and passes it as PATH", () => {
    const parent = { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\a\\AppData", LANG: "C" };
    expect(checkChildEnv(parent, "C:\\Users\\a", "win32")).toEqual({
      PATH: "C:\\Windows\\System32",
      LANG: "C",
      HOME: "C:\\Users\\a",
      GH_PROMPT_DISABLED: "1",
      NO_UPDATE_NOTIFIER: "1",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      CI: "1",
      COREPACK_ENABLE_NETWORK: "0",
      VERCEL_TELEMETRY_DISABLED: "1",
    });
    expect(checkChildEnv(parent, "/home/a", "linux")).not.toHaveProperty("PATH");
  });

  it("on Windows reports npm, pnpm and vercel that cannot be started as unsupported, not missing", async () => {
    const commands = [["npm", "--version"], ["pnpm", "--version"], ["vercel", "--version"], ["gh", "--version"]];
    const fake = fakeSpawn({});
    const ctx = contextFor({ id: "node", commands, files: [] }, { spawn: fake.spawn, platform: "win32" });
    expect(await Promise.all(commands.map((argv) => ctx.exec(argv)))).toEqual([
      { unavailable: "unsupported" },
      { unavailable: "unsupported" },
      { unavailable: "unsupported" },
      { unavailable: "not_installed" },
    ]);
    const linux = contextFor({ id: "node", commands, files: [] }, { spawn: fake.spawn, platform: "linux" });
    await expect(linux.exec(["npm", "--version"])).resolves.toEqual({ unavailable: "not_installed" });
  });

  it("reports a missing binary as not_installed", async () => {
    const argv = ["raft-computer-checks-no-such-binary", "--version"];
    const ctx = contextFor({ id: "stamp", commands: [argv], files: [] });
    await expect(ctx.exec(argv)).resolves.toEqual({ unavailable: "not_installed" });
  });

  it("kills a command that runs past its timeout and reports timeout", async () => {
    const hang = [process.execPath, "-e", "setTimeout(() => {}, 60000)"];
    const ctx = contextFor({ id: "node", commands: [hang], files: [] }, { commandTimeoutMs: 200 });
    const started = Date.now();
    await expect(ctx.exec(hang)).resolves.toEqual({ unavailable: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === "win32")("kills what a timed-out command started, too", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "computer-checks-tree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    const argv = [process.execPath, "-e", script];
    try {
      const ctx = contextFor({ id: "node", commands: [argv], files: [] }, { commandTimeoutMs: 1_500 });
      await expect(ctx.exec(argv)).resolves.toEqual({ unavailable: "timeout" });
      const grandchild = Number(readFileSync(pidFile, "utf8"));
      expect(grandchild).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 3_000;
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows kills a timed-out command with taskkill by absolute path and the command's minimal env", async () => {
    const spawned: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spawnFn = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawned.push({ command, args, env: options.env });
      return Object.assign(new EventEmitter(), {});
    }) as unknown as NonNullable<KillTreeOptions["spawnFn"]>;
    const env = checkChildEnv({ PATH: "C:\\agent-bin", GITHUB_TOKEN: FAKE_GH_TOKEN }, "C:\\Users\\a", "win32");

    killCheckTree(4242, "win32", env, { spawnFn, systemRoot: "D:\\Win" });
    killCheckTree(4243, "win32", env, { spawnFn, systemRoot: "" });

    expect(spawned).toEqual([
      { command: "D:\\Win\\System32\\taskkill.exe", args: ["/PID", "4242", "/T", "/F"], env },
      { command: "C:\\Windows\\System32\\taskkill.exe", args: ["/PID", "4243", "/T", "/F"], env },
    ]);
    expect(JSON.stringify(spawned)).not.toContain("FAKE");
  });

  it("passes the command's own minimal env to the tree kill on timeout", async () => {
    const kills: Array<{ pid: number; platform: NodeJS.Platform; env: Record<string, string> }> = [];
    let child: (EventEmitter & { pid: number; stdout: PassThrough; kill: () => boolean }) | undefined;
    const spawn: CheckSpawn = () => {
      child = Object.assign(new EventEmitter(), { pid: 777, stdout: new PassThrough(), kill: () => true });
      return child as unknown as CheckChildProcess;
    };
    const ctx = contextFor({ id: "github", commands: [["gh", "--version"]], files: [] }, {
      spawn,
      platform: "win32",
      parentEnv: { Path: "C:\\bin", GITHUB_TOKEN: FAKE_GH_TOKEN },
      homeDir: "C:\\Users\\a",
      commandTimeoutMs: 50,
      killTree: (pid, platform, env) => {
        kills.push({ pid, platform, env });
        child?.emit("close", null);
      },
    });

    await expect(ctx.exec(["gh", "--version"])).resolves.toEqual({ unavailable: "timeout" });
    expect(kills).toEqual([{ pid: 777, platform: "win32", env: checkChildEnv({ Path: "C:\\bin" }, "C:\\Users\\a", "win32") }]);
  });

  it("holds its slot until a timed-out command has exited", async () => {
    const fake = fakeSpawn({ "a --version": "hang", "b --version": { stdout: "1.0.0" } });
    const ctx = contextFor({ id: "node", commands: [["a", "--version"], ["b", "--version"]], files: [] }, { spawn: fake.spawn, slots: commandSlots(1), commandTimeoutMs: 50 });
    const results = await Promise.all([ctx.exec(["a", "--version"]), ctx.exec(["b", "--version"])]);
    expect(results).toEqual([{ unavailable: "timeout" }, { stdout: "1.0.0", exitCode: 0 }]);
    expect(fake.maxRunning()).toBe(1);
  });

  it("fails a command whose stdout passes 64 KB", async () => {
    const flood = [process.execPath, "-e", "process.stdout.write('x'.repeat(70 * 1024))"];
    const ctx = contextFor({ id: "node", commands: [flood], files: [] });
    await expect(ctx.exec(flood)).resolves.toEqual({ unavailable: "failed" });
  });

  it("runs at most 3 commands at once", async () => {
    const commands = ["a", "b", "c", "d", "e", "f"].map((name) => [name, "--version"]);
    const fake = fakeSpawn(Object.fromEntries(commands.map((argv) => [argv.join(" "), { stdout: "1.0.0" }])));
    const ctx = contextFor({ id: "node", commands, files: [] }, { spawn: fake.spawn });
    await Promise.all(commands.map((argv) => ctx.exec(argv)));
    expect(fake.calls).toHaveLength(6);
    expect(fake.maxRunning()).toBe(3);
  });
});

describe("CheckContext.readKeys", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "computer-checks-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("refuses a file the check did not declare, and a param outside its shape", async () => {
    const declared: DeclaredFile = { path: "cfg_{param}", format: "line", paramShape: (raw) => (/^[a-z]+$/.test(raw) ? raw : undefined), keys: [] };
    const other: DeclaredFile = { path: ".aws/credentials", format: "ini", keys: [] };
    const ctx = contextFor({ id: "gcloud", commands: [], files: [declared] }, { homeDir: home });

    await expect(ctx.readKeys(other)).rejects.toThrow(/not declared/);
    await expect(ctx.readKeys(declared, "../../etc/passwd")).rejects.toThrow(/bad file param/);
    await expect(ctx.readKeys(declared)).rejects.toThrow(/bad file param/);
    await expect(ctx.readKeys(declared, "ok")).resolves.toEqual({ unavailable: "missing" });
  });

  it("keeps the declared key of gh hosts.yml and never the token beside it", async () => {
    const hosts: DeclaredFile = { path: ".config/gh/hosts.yml", format: "yaml", sectionShape: hostnameShape, keys: [{ key: "user", shape: githubLoginShape }] };
    await mkdir(path.join(home, ".config/gh"), { recursive: true });
    await writeFile(path.join(home, ".config/gh/hosts.yml"), [
      "github.com:",
      "    users:",
      "        octocat:",
      `            oauth_token: ${FAKE_GH_TOKEN}`,
      "    git_protocol: https",
      `    oauth_token: ${FAKE_GH_TOKEN}`,
      "    user: octocat",
      "ghe.example.com:",
      "    user: \"bad user; rm -rf\"",
      `    oauth_token: ${FAKE_GH_TOKEN}`,
      "",
    ].join("\n"));
    const ctx = contextFor({ id: "github", commands: [], files: [hosts] }, { homeDir: home });

    const result = await ctx.readKeys(hosts);

    expect(result).toEqual({
      sections: [
        { name: "github.com", values: { user: "octocat" } },
        { name: "ghe.example.com", values: {} },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_GH_TOKEN);
  });

  it.skipIf(process.platform === "win32")("returns a FIFO at a declared path as unreadable without blocking on it", async () => {
    const declared: DeclaredFile = { path: ".npmrc", format: "ini", keys: [] };
    execFileSync("mkfifo", [path.join(home, ".npmrc")]);
    const ctx = contextFor({ id: "npm", commands: [], files: [declared] }, { homeDir: home });
    const started = Date.now();
    await expect(ctx.readKeys(declared)).resolves.toEqual({ unavailable: "unreadable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reads a hosts.yml with a 250 KB whitespace line quickly and takes no value from that line", async () => {
    const hosts: DeclaredFile = { path: ".config/gh/hosts.yml", format: "yaml", sectionShape: hostnameShape, keys: [{ key: "user", shape: githubLoginShape }] };
    await mkdir(path.join(home, ".config/gh"), { recursive: true });
    const run = " ".repeat(250 * 1024);
    await writeFile(path.join(home, ".config/gh/hosts.yml"), [
      "github.com:",
      `    user: octocat${run}x`,
      " ".repeat(4096),
      "ghe.example.com:",
      `    user: hubot${" ".repeat(900)}# a comment`,
      "",
    ].join("\n"));
    const ctx = contextFor({ id: "github", commands: [], files: [hosts] }, { homeDir: home });

    const started = performance.now();
    const result = await ctx.readKeys(hosts);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toEqual({
      sections: [
        { name: "github.com", values: {} },
        { name: "ghe.example.com", values: { user: "hubot" } },
      ],
    });

    // An over-long top-level line may start a section: not understood.
    const started2 = performance.now();
    expect(readDeclaredKeys(hosts, `github.com${run}:\n    user: octocat\n`)).toEqual({ unavailable: "parse_failed" });
    expect(performance.now() - started2).toBeLessThan(500);
  });

  it("does not read a declared file over the size cap", async () => {
    const declared: DeclaredFile = { path: ".npmrc", format: "ini", keys: [{ key: "registry", shape: registryUrlShape }] };
    await writeFile(path.join(home, ".npmrc"), `registry=https://registry.example.com\n#${"x".repeat(DECLARED_FILE_MAX_BYTES)}\n`);
    const ctx = contextFor({ id: "npm", commands: [], files: [declared] }, { homeDir: home });
    await expect(ctx.readKeys(declared)).resolves.toEqual({ unavailable: "parse_failed" });
  });
});

describe("declared keys and shapes", () => {
  it("keeps only a registry's origin and records an auth token only as present", () => {
    const npmrc: DeclaredFile = {
      path: ".npmrc",
      format: "ini",
      keys: [{ key: "registry", shape: registryUrlShape }, { key: "_authToken", match: "suffix", shape: presenceShape }],
    };
    const result = readDeclaredKeys(npmrc, [
      "registry=https://alice:hunter2@registry.example.com/npm/?token=abc#frag",
      `//registry.example.com/npm/:_authToken=${FAKE_NPM_TOKEN}`,
      "always-auth=true",
    ].join("\n"));

    expect(result).toEqual({ sections: [{ name: "", values: { registry: "https://registry.example.com", _authToken: "present" } }] });
    expect(JSON.stringify(result)).not.toMatch(/alice|hunter2|token=abc|FAKE/);
  });

  it("drops a registry that is not http(s)", () => {
    expect(registryUrlShape("https://registry.example.com:8443/scope/_auth/abc?x=1")).toBe("https://registry.example.com:8443");
    expect(registryUrlShape("file:///etc/passwd")).toBeUndefined();
    expect(registryUrlShape("not a url")).toBeUndefined();
  });

  it("keeps aws profiles and only region-shaped regions", () => {
    const config: DeclaredFile = { path: ".aws/config", format: "ini", sectionShape: awsProfileSectionShape, keys: [{ key: "region", shape: awsRegionShape }] };
    const result = readDeclaredKeys(config, [
      "[default]",
      "region = us-east-1",
      "[profile gov]",
      "region = us-gov-west-1",
      "[profile bad]",
      "region = us-east-1; curl evil",
      "aws_secret_access_key = FAKEawsSecretAccessKey0123456789",
      "[profile weird name]",
      "region = eu-west-1",
      "[sso-session corp]",
      "sso_region = us-east-1",
      "[profile s3cfg]",
      "s3 =",
      "  max_concurrent_requests = 20",
    ].join("\n"));

    expect(result).toEqual({
      sections: [
        { name: "default", values: { region: "us-east-1" } },
        { name: "gov", values: { region: "us-gov-west-1" } },
        { name: "bad", values: {} },
        { name: "s3cfg", values: {} },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("FAKEaws");
  });

  it("reports parse_failed for a file it does not understand, without any of its content", () => {
    const hosts: DeclaredFile = { path: ".config/gh/hosts.yml", format: "yaml", sectionShape: hostnameShape, keys: [{ key: "user", shape: githubLoginShape }] };
    for (const corrupt of [
      `github.com:\n\toauth_token: ${FAKE_GH_TOKEN}\n`,
      `${FAKE_GH_TOKEN}\n`,
      `  user: octocat\n  oauth_token: ${FAKE_GH_TOKEN}\n`,
      `github.com:\n    user: octocat\n  oauth_token: ${FAKE_GH_TOKEN}\n`,
    ]) {
      const result = readDeclaredKeys(hosts, corrupt);
      expect(result).toEqual({ unavailable: "parse_failed" });
      expect(JSON.stringify(result)).not.toContain(FAKE_GH_TOKEN);
    }
    const ini: DeclaredFile = { path: ".npmrc", format: "ini", keys: [] };
    expect(readDeclaredKeys(ini, `${FAKE_NPM_TOKEN}\n`)).toEqual({ unavailable: "parse_failed" });
  });

  it("masks a display name holding an email and drops control and bidi characters", () => {
    expect(displayNameShape("  Alice Example ")).toBe("Alice Example");
    expect(displayNameShape("alice.example@example.com")).toBe("ali****ample@example.com");
    expect(displayNameShape("Alice <alice.example@example.com>")).toBeUndefined();
    for (const bad of ["Ali\u0085ce", "Ali\u009bce", "Ali\u202ece", "Ali\u2066ce", "Ali\u2069ce", "Ali\u0007ce", "", "a".repeat(81)]) {
      expect(displayNameShape(bad)).toBeUndefined();
    }
  });

  it("drops a display name with any invisible character the shared plain-text rule removes", () => {
    expect(displayNameShape("José Müller")).toBe("José Müller");
    for (const invisible of ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2028", "\u2029", "\u2060", "\ufeff", "\u00ad", "\u{E0001}", "\u{E0041}", "\u{E007F}", "\t"]) {
      expect(displayNameShape(`Ali${invisible}ce`)).toBeUndefined();
    }
  });

  it("finds a version only near the start of the output and never a giant one", () => {
    expect(versionShape("gh version 2.40.1 (2023-12-13)")).toBe("2.40.1");
    expect(versionShape("v24.3.0-rc.1\n")).toBe("24.3.0-rc.1");
    for (const flood of ["9".repeat(64 * 1024), `1.${"9".repeat(64 * 1024)}`, `${"9".repeat(64 * 1024)}.1`, `${"x".repeat(1024)} 1.2.3`]) {
      const started = performance.now();
      expect(versionShape(flood)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("drops logins outside GitHub's username charset", () => {
    expect(githubLoginShape("octo-cat")).toBe("octo-cat");
    expect(githubLoginShape("-octocat")).toBeUndefined();
    expect(githubLoginShape("octo--cat")).toBeUndefined();
    expect(githubLoginShape("a".repeat(40))).toBeUndefined();
    expect(githubLoginShape(FAKE_GH_TOKEN)).toBeUndefined();
  });
});
