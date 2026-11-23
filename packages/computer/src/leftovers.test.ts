// `raft-computer leftovers` (#raft-architecture:#34): read-only listing of
// what agents run on this Computer. Fake process listings, ledgers in a temp
// Raft home, fake systemctl/docker answers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listLinuxProcesses,
  listListeningPorts,
  parseLsofListeners,
  parseProcNetTcpListeners,
  parsePsArgsListing,
  parsePsCommListing,
  parsePsEnvListing,
  PS_COMM_LISTING_ARGS,
  type ListedProcess,
} from "@botiverse/raft-shared/src/agentLeftovers";
import { program } from "./cli";
import { formatLeftovers, LEFTOVERS_UNSUPPORTED_MESSAGE, readLeftovers, type LeftoversDeps } from "./leftovers";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = 10_000_000;

function proc(pid: number, overrides: Partial<ListedProcess> = {}): ListedProcess {
  return { pid, ppid: 1, pgid: pid, uid: 1000, startIdentity: `linux:${pid}`, startedAtMs: NOW - 2 * 3_600_000, command: "node", agentId: null, ...overrides };
}

function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "raft-leftovers-"));
  return fn(home).finally(() => rmSync(home, { recursive: true, force: true }));
}

test("lists each agent's processes with age and ports, marking its runtime and raft proc jobs; previews and containers with owners", async () => {
  await withHome(async (home) => {
    const machine = join(home, "machines", "m1");
    mkdirSync(join(machine, "daemon.lock"), { recursive: true });
    writeFileSync(join(machine, "runtime-processes.json"), JSON.stringify({
      version: 1,
      processes: [{ pid: 300, pgid: 300, startIdentity: "linux:300", agentId: A, launchId: null, host: "legacy", recordedAtMs: 0 }],
    }));
    writeFileSync(join(machine, "proc-jobs.json"), JSON.stringify({
      version: 1,
      jobs: [{
        agentId: B, name: "web", pid: 400, pgid: 400, startIdentity: "linux:400", command: "vite", startedAtMs: 0,
        logPath: "/x", scope: "none", state: "running", exitCode: null, exitSignal: null, exitedAtMs: null, adopted: false,
      }],
    }));
    const commands: string[] = [];
    const deps: LeftoversDeps = {
      platform: "linux",
      selfPid: 999,
      listProcesses: async () => [
        proc(300, { agentId: A, command: "claude" }),
        proc(301, { agentId: A, command: "cloudflared", startedAtMs: NOW - 5 * 60_000 }),
        proc(302, { agentId: A, command: "ssh-agent" }),
        proc(303, { ppid: 300, agentId: A, command: "bash" }),
        proc(500, { command: "node" }),
        proc(501, { ppid: 500, agentId: B, command: "codex" }),
        proc(400, { agentId: B, command: "node" }),
        proc(500, { command: "bash" }),
        proc(999, { agentId: A, command: "raft-computer" }),
      ],
      listeningPorts: async (pids) => {
        assert.deepEqual([...pids].sort(), [300, 301, 302, 303, 400, 501]);
        return new Map([[400, ["*:5173"]]]);
      },
      previewUnits: () => [
        { id: "11111111-1111-4111-8111-111111111111", unitName: "raft-preview-11111111-1111-4111-8111-111111111111.service", name: "review-x", ownerAgentId: A },
      ],
      run: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl") return { code: 0, stdout: "active\n" };
        return { code: 0, stdout: `0123456789ab\tslock-dev-b-postgres\trunning\t${B}\n` };
      },
      procJobs: { platform: "linux", readIdentity: async (pid) => ({ pgid: pid, startIdentity: `linux:${pid}` }) },
    };
    const report = await readLeftovers(home, deps);
    assert.deepEqual(report.processes.map((row) => [row.pid, row.agentId.slice(0, 8), row.kind, row.command, row.listening]), [
      [300, "aaaaaaaa", "runtime", "claude", []],
      [301, "aaaaaaaa", "process", "cloudflared", []],
      [302, "aaaaaaaa", "process", "ssh-agent", []],
      [303, "aaaaaaaa", "process", "bash", []],
      [400, "bbbbbbbb", "proc_job", "node", ["*:5173"]],
      [501, "bbbbbbbb", "process", "codex", []],
    ]);
    assert.equal(report.previews?.[0]?.state, "active");
    assert.equal(report.containers?.[0]?.agentId, B);
    assert.ok(commands.some((line) => line.startsWith("systemctl --user is-active raft-preview-")));
    assert.ok(commands.some((line) => line.startsWith("docker ps -a --filter label=com.botiverse.raftdev.managed=true --format")));

    const text = formatLeftovers(report, NOW).join("\n");
    assert.match(text, /Agent processes \(SLOCK_AGENT_ID\): 6/);
    assert.doesNotMatch(text, /ON LEAVE/);
    assert.match(text, /aaaaaaaa\s+301\s+5m\s+shell\s+cloudflared/);
    assert.match(text, /bbbbbbbb\s+400\s+2h\s+raft proc\s+node\s+\*:5173/);
    assert.match(text, /raftdev previews: 1\n.*\n\s+aaaaaaaa\s+active\s+raft-preview-1111/);
    assert.match(text, /raftdev containers: 1\n.*\n\s+bbbbbbbb\s+running\s+slock-dev-b-postgres/);
    assert.match(text, /Nothing was stopped/);
    assert.match(text, /keep running until you stop them/);
    // JSON is the same report.
    assert.deepEqual(JSON.parse(JSON.stringify(report)).processes[1], {
      pid: 301, agentId: A, startedAtMs: NOW - 300_000, command: "cloudflared", kind: "process", listening: [],
    });
  });
});

test("macOS: no preview units (systemd only); docker absent says so", async () => {
  await withHome(async (home) => {
    const report = await readLeftovers(home, {
      platform: "darwin",
      listProcesses: async () => [],
      listeningPorts: async () => new Map(),
      run: async () => ({ code: -1, stdout: "" }),
    });
    assert.equal(report.previews, null);
    assert.equal(report.containers, null);
    const text = formatLeftovers(report, NOW);
    assert.deepEqual(text.filter(Boolean).slice(0, 2), ["Agent processes (SLOCK_AGENT_ID): none", "raftdev containers: docker not available"]);
  });
});

test("Windows: unsupported, and says so", async () => {
  const report = await readLeftovers("/nowhere", { platform: "win32" });
  assert.deepEqual(report, { supported: false, processes: [], previews: null, containers: null });
  assert.deepEqual(formatLeftovers(report, NOW), [LEFTOVERS_UNSUPPORTED_MESSAGE]);
});

test("listening ports: Linux /proc/net/tcp{,6} matched to the pid's sockets; lsof elsewhere", async () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0",
    "   2: 0100007F:9C40 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  const tcp6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  assert.deepEqual([...parseProcNetTcpListeners(tcp, false)], [["111", "*:5173"], ["222", "127.0.0.1:8080"]]);
  assert.deepEqual([...parseProcNetTcpListeners(tcp6, true)], [["444", "[::1]:3000"]]);
  const links: Record<string, string> = {
    "/proc/7/fd/3": "socket:[111]",
    "/proc/7/fd/4": "socket:[333]",
    "/proc/7/fd/5": "/dev/null",
    "/proc/8/fd/3": "socket:[444]",
  };
  const ports = await listListeningPorts([7, 8, 9], {
    platform: "linux",
    env: {},
    readFile: (file) => (file.endsWith("tcp6") ? tcp6 : tcp),
    readDir: (dir) => {
      const prefix = `${dir}/`;
      const fds = Object.keys(links).filter((link) => link.startsWith(prefix)).map((link) => link.slice(prefix.length));
      if (fds.length === 0) throw new Error("ENOENT");
      return fds;
    },
    readLink: (file) => links[file] ?? "",
  });
  assert.deepEqual([...ports], [[7, ["*:5173"]], [8, ["[::1]:3000"]]]);
  assert.deepEqual([...parseLsofListeners("p12\nf5\nn*:5173\nf6\nn127.0.0.1:9229\np13\nn[::1]:3000\n")], [[12, ["*:5173", "127.0.0.1:9229"]], [13, ["[::1]:3000"]]]);
});

test("the command is registered, read-only, with --json", () => {
  const command = program.commands.find((child) => child.name() === "leftovers");
  assert.ok(command);
  assert.ok(command.options.some((option) => option.long === "--json"));
  assert.match(command.description(), /Stops nothing/);
});

test("Linux: a process names the agent its own environment carries; another user's environment is not read", () => {
  const files = new Map<string, string>();
  const owners = new Map<string, number>();
  const add = (pid: number, argv: string[], env: Record<string, string> | null, uid = 1000) => {
    files.set(`/proc/${pid}/stat`, `${pid} (${argv[0]}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid}00 0 0`);
    files.set(`/proc/${pid}/cmdline`, `${argv.join("\0")}\0`);
    if (env) files.set(`/proc/${pid}/environ`, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0")}\0`);
    owners.set(`/proc/${pid}`, uid);
  };
  add(601, ["/usr/local/bin/cloudflared", "tunnel", "--url", "http://localhost:5173"], { PATH: "/bin", SLOCK_AGENT_ID: A });
  add(630, ["/usr/bin/sleep", "100"], { SLOCK_AGENT_ID: A }, 0);
  add(650, ["/usr/bin/env-less"], null);
  const listing = listLinuxProcesses(1000, {
    readDir: () => ["self", ...new Set([...files.keys()].map((file) => file.split("/")[2]!))],
    readFile: (file) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from(text);
    },
    ownerUid: (file) => owners.get(file) ?? null,
    bootTimeMs: 1_000_000,
  });
  assert.deepEqual(listing.find((entry) => entry.pid === 601), {
    pid: 601, ppid: 1, pgid: 601, uid: 1000, startIdentity: "linux:60100", startedAtMs: 1_000_000 + 601_000, command: "cloudflared", agentId: A,
  });
  assert.equal(listing.find((entry) => entry.pid === 630)?.agentId, null);
  assert.equal(listing.find((entry) => entry.pid === 650)?.agentId, null);
});

test("macOS: only what follows a row's exact arguments is its environment; a row that doesn't line up has none", () => {
  const lstart = "Thu Nov 19 10:00:00 2026";
  const plain = [
    `  501 ${lstart}     /opt/homebrew/bin/cloudflared tunnel --url http://localhost:5173`,
    `  502 ${lstart}     ssh box SLOCK_AGENT_ID=${A} uptime`,
    `  503 ${lstart}     docker run -e SLOCK_AGENT_ID=${A} alpine`,
    `  504 Thu Nov  9 09:05:07 2026     node /Users/me/w/node_modules/.bin/vite`,
    `  505 ${lstart}     /bin/sleep 9`,
    // 506 is missing here (started between the two listings).
  ].join("\n");
  const withEnv = [
    `  501     1   501   501 ${lstart}     /opt/homebrew/bin/cloudflared tunnel --url http://localhost:5173 TERM=xterm SLOCK_AGENT_ID=${A}`,
    // A human's commands: only their arguments name A.
    `  502     1   502   501 ${lstart}     ssh box SLOCK_AGENT_ID=${A} uptime TERM=xterm`,
    `  503     1   503   501 ${lstart}     docker run -e SLOCK_AGENT_ID=${A} alpine HOME=/Users/me`,
    `  504     1   504   501 Thu Nov  9 09:05:07 2026     node /Users/me/w/node_modules/.bin/vite SHELL=/bin/zsh SLOCK_AGENT_ID=${B}`,
    // Another start than the plain listing's: a reused pid, unreadable.
    `  505     1   505   501 Thu Nov 19 10:00:09 2026     /bin/sleep 9 SLOCK_AGENT_ID=${A}`,
    `  506     1   506   501 ${lstart}     /bin/sleep 1 SLOCK_AGENT_ID=${A}`,
    `  507     1   507     0 ${lstart}     /usr/sbin/sshd SLOCK_AGENT_ID=${A}`,
    "garbage line",
  ].join("\n");
  const listing = parsePsEnvListing(withEnv, 501, parsePsArgsListing(plain));
  assert.deepEqual(listing.map((entry) => [entry.pid, entry.command, entry.agentId]), [
    [501, "cloudflared", A],
    [502, "ssh", null],
    [503, "docker", null],
    [504, "node", B],
    [505, "sleep", null],
    [506, "sleep", null],
    [507, "sshd", null],
  ]);
  assert.equal(listing[3]?.startIdentity, "ps:Thu Nov 9 09:05:07 2026");
});

test("macOS: an executable path with spaces, or read whole (-ww), keeps its basename; a comm cut short falls back to the arguments' first word", () => {
  const lstart = "Thu Nov 19 10:00:00 2026";
  const studio = "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java";
  const studioArgs = `${studio} -Xmx2g -cp /Users/me/.gradle/wrapper/gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.7`;
  const spaced = parsePsEnvListing(
    `  701     1   701   501 ${lstart}     ${studioArgs} SLOCK_AGENT_ID=${A}`,
    501,
    parsePsArgsListing(`  701 ${lstart}     ${studioArgs}`),
    parsePsCommListing(`  701 ${lstart}     ${studio}`),
  );
  assert.deepEqual(spaced.map((entry) => [entry.command, entry.agentId]), [["java", A]]);

  const java = "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java";
  const args = `${java} -cp /Users/me/.gradle/wrapper/dists/gradle-8.7/lib/gradle-launcher-8.7.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.7`;
  const plain = parsePsArgsListing(`  702 ${lstart}     ${args}`);
  const envRow = `  702     1   702   501 ${lstart}     ${args} SLOCK_AGENT_ID=${A}`;
  assert.equal(parsePsEnvListing(envRow, 501, plain, parsePsCommListing(`  702 ${lstart}     ${java}`))[0]?.command, "java");
  // Cut at 79 columns: a prefix of the arguments, but not ending at a space.
  assert.equal(parsePsEnvListing(envRow, 501, plain, parsePsCommListing(`  702 ${lstart}     ${java.slice(0, 40)}`))[0]?.command, "java");
  // A comm that is no prefix at all: the arguments' first word.
  assert.equal(parsePsEnvListing(envRow, 501, plain, parsePsCommListing(`  702 ${lstart}     /usr/bin/something-else`))[0]?.command, "java");
  // Not cut at the terminal's width when ps writes to a pipe.
  assert.ok(PS_COMM_LISTING_ARGS.includes("-ww"));
});
