// `raft proc` output text and its refusals, against a fake daemon proxy. The
// daemon side (real processes) is packages/daemon/src/procJobs.test.ts.
import assert from "node:assert/strict";
import path from "node:path";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import type { CliIo } from "../../core/io";
import { buildRaftProgram, runRaftArgv } from "../../program";
import { createCommandContext } from "../../core/context";
import { runProcLogs } from "./logs";
import type { ProcJob } from "./_format";

const managed: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:12345",
  serverId: null,
  token: "sap_proxy",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-file",
  activeCapabilities: null,
};

const NOW = Date.now();
const LOG = "/Users/q/.slock/machines/m1/proc/agent-1/web.log";

function job(overrides: Partial<ProcJob> = {}): ProcJob {
  return {
    name: "web",
    pid: 4242,
    state: "running",
    command: "node",
    startedAt: new Date(NOW - 2 * 3600_000 - 5_000).toISOString(),
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    logPath: LOG,
    scope: "none",
    adopted: false,
    ...overrides,
  };
}

type Reply = ApiResponse<unknown>;
type Handler = (method: string, pathname: string, body: unknown) => Reply;

const ok = (data: unknown): Reply => ({ ok: true, status: 200, data, error: null });
const refused = (status: number, code: string, error: string): Reply => ({ ok: false, status, data: null, error, errorCode: code });
const listing = (jobs: ProcJob[]) => ok({ capability: "proc@1", jobs, maxJobs: 8 });

async function run(argv: string[], handler: Handler, options: { context?: AgentContext } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
  };
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const program = buildRaftProgram({
    io,
    env: { PATH: "/usr/bin", SLOCK_AGENT_ID: "agent-1" },
    loadAgentContext: () => options.context ?? managed,
    createApiClient: () => ({
      request: async (method: string, pathname: string, body?: unknown) => {
        requests.push({ method, path: pathname, body });
        return handler(method, pathname, body);
      },
    }) as never,
  });
  const exitCode = await runRaftArgv(program, ["node", "raft", ...argv], io);
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), requests };
}

test("start: the command after -- goes to the daemon with an absolute cwd, the env and the CLI's pid; the reply names the job, pid, log and next commands", async () => {
  const result = await run(["proc", "start", "--name", "web", "--cwd", "app", "--", "node", "server.js", "--port", "3000"], (method, pathname) => {
    if (method === "GET") return listing([]);
    assert.equal(pathname, "/internal/agent-api/proc/start");
    return ok({ capability: "proc@1", job: job(), autoNamed: false });
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `Started web (pid 4242), log ${LOG}. Logs: raft proc logs web · Stop: raft proc stop web\n`);
  assert.deepEqual(result.requests.map((request) => `${request.method} ${request.path}`), ["GET /internal/agent-api/proc", "POST /internal/agent-api/proc/start"]);
  assert.deepEqual(result.requests[1]!.body, {
    name: "web",
    argv: ["node", "server.js", "--port", "3000"],
    cwd: path.resolve(process.cwd(), "app"),
    env: { PATH: "/usr/bin", SLOCK_AGENT_ID: "agent-1" },
    callerPid: process.pid,
  });
});

test("start without --name says the name was made from the command", async () => {
  const result = await run(["proc", "start", "--", "node", "a.js"], (method) => method === "GET"
    ? listing([job()])
    : ok({ capability: "proc@1", job: job({ name: "node-2", pid: 4300 }), autoNamed: true }));
  assert.equal(result.stdout, `Started node-2 (pid 4300), named after the command (choose one with --name), log ${LOG}. Logs: raft proc logs node-2 · Stop: raft proc stop node-2\n`);
});

test("start where the job shares the Computer service's cgroup adds one line saying a service restart ends it", async () => {
  const result = await run(["proc", "start", "--name", "web", "--", "node", "a.js"], (method) => method === "GET"
    ? listing([])
    : ok({ capability: "proc@1", job: job(), autoNamed: false, stopsWithService: true }));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Started web (pid 4242), log ${LOG}. Logs: raft proc logs web · Stop: raft proc stop web\nOn this Computer, jobs stop when the Computer service restarts (an upgrade restarts it): raft proc list shows whether this one is still running.\n`,
  );
});

test("start refusals: a running duplicate name, the 9th job (with the running jobs), an invalid name before any request", async () => {
  const duplicate = await run(["proc", "start", "--name", "web", "--", "sleep", "9"], (method) => method === "GET"
    ? listing([job()])
    : refused(409, "proc_name_taken", "A job named web is already running; stop it (raft proc stop web) or pick another --name"));
  assert.equal(duplicate.exitCode, 1);
  assert.match(duplicate.stderr, /^Error: A job named web is already running; stop it \(raft proc stop web\) or pick another --name\nCode: PROC_NAME_TAKEN\n/);

  const eight = Array.from({ length: 8 }, (_, i) => job({ name: `job${i}`, pid: 5000 + i, command: "sleep" }));
  const capped = await run(["proc", "start", "--", "sleep", "9"], (method) => method === "GET"
    ? listing(eight)
    : refused(409, "proc_limit", "This agent already runs 8 jobs, the most it can run at once"));
  assert.equal(capped.exitCode, 1);
  assert.ok(capped.stderr.startsWith([
    "Error: This agent already runs 8 jobs, the most it can run at once (8):",
    ...eight.map((entry) => `  ${entry.name} · running 2h · pid ${entry.pid} · sleep`),
    "Stop one first: raft proc stop job0",
    "Code: PROC_LIMIT",
  ].join("\n")), capped.stderr);

  const invalid = await run(["proc", "start", "--name", "my web", "--", "sleep", "9"], () => assert.fail("no request for an invalid name"));
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /Code: PROC_INVALID_NAME/);
});

test("start: the daemon's scope and full-access refusals say why and what to do instead", async () => {
  const scope = "This agent's commands run in their own resource scope on this Computer, and the daemon couldn't confirm this command runs inside it, so it won't start a job outside that budget; start it with nohup inside your own process group and stop it with kill -- -<pgid>";
  const access = "This agent's runtime (qwen) isn't known to run with full access, and a job would run with more access than the agent has, so this Computer won't start it; start it with nohup inside your own process group and stop it with kill -- -<pgid>";
  for (const [code, message, cliCode] of [["proc_scope_unconfirmed", scope, "PROC_SCOPE_UNCONFIRMED"], ["proc_runtime_restricted", access, "PROC_RUNTIME_RESTRICTED"]] as const) {
    const result = await run(["proc", "start", "--", "sleep", "9"], (method) => method === "GET" ? listing([]) : refused(403, code, message));
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.startsWith(`Error: ${message}\nCode: ${cliCode}\n`), result.stderr);
  }
});

test("an older daemon, a Windows daemon and an agent no Computer runs each get their refusal; nothing is started", async () => {
  const older = await run(["proc", "start", "--", "sleep", "9"], (method) => {
    assert.equal(method, "GET", "an older daemon would forward a start (and its environment) to the Server");
    return refused(404, "not_found", "Not found");
  });
  assert.equal(older.exitCode, 1);
  assert.ok(older.stderr.startsWith("Error: This Computer's daemon doesn't run jobs yet; update the Computer, or start it with nohup inside your own process group and stop it with kill -- -<pgid>\nCode: PROC_UNSUPPORTED\n"), older.stderr);

  const forwardedOk = await run(["proc", "list"], () => ok({ messages: [] }));
  assert.match(forwardedOk.stderr, /This Computer's daemon doesn't run jobs yet/);

  const windows = await run(["proc", "list"], () => refused(501, "proc_unsupported", "x"));
  assert.match(windows.stderr, /doesn't run jobs on this platform yet/);

  const unmanaged = await run(["proc", "list"], () => assert.fail("no request"), { context: { ...managed, clientMode: "self-hosted-runner" } });
  assert.match(unmanaged.stderr, /^Error: raft proc runs jobs through the Computer that runs this agent/);
});

test("list: one row per job and the next commands; an empty list says how to start one", async () => {
  const result = await run(["proc", "list"], () => listing([
    job(),
    job({ name: "bot", pid: 4300, state: "exited", exitCode: 1, exitedAt: new Date(NOW - 5 * 60_000 - 1_000).toISOString() }),
    job({ name: "old", pid: 4400, state: "exited", adopted: true, exitedAt: new Date(NOW - 90_000).toISOString() }),
  ]));
  assert.equal(result.stdout, [
    "web · running 2h · pid 4242 · node",
    "bot · exited (code 1) 5m ago",
    "old · exited 1m ago",
    "Logs: raft proc logs old · Stop: raft proc stop web",
    "",
  ].join("\n"));
  const noneRunning = await run(["proc", "list"], () => listing([
    job({ name: "bot", pid: 4300, state: "exited", exitCode: 1, exitedAt: new Date(NOW - 5 * 60_000 - 1_000).toISOString() }),
  ]));
  assert.equal(noneRunning.stdout, "bot · exited (code 1) 5m ago\nLogs: raft proc logs bot\n");
  const empty = await run(["proc", "list"], () => listing([]));
  assert.equal(empty.stdout, "No jobs. Start one: raft proc start --name <name> -- <command> [args...]\n");
});

test("stop: SIGTERM exit, a kill after the grace, --force, an exited job, an unknown name", async () => {
  const stop = (outcome: string, graceMs: number, stopped = job()) => (method: string) => method === "GET"
    ? listing([job()])
    : ok({ capability: "proc@1", job: stopped, outcome, graceMs });
  assert.equal((await run(["proc", "stop", "web"], stop("exited", 10_000))).stdout, "Stopped web (pid 4242). List: raft proc list\n");
  assert.equal((await run(["proc", "stop", "web"], stop("killed", 10_000))).stdout, "Stopped web (pid 4242): killed after the 10 s grace. List: raft proc list\n");
  const forced = await run(["proc", "stop", "web", "--force"], stop("killed", 0));
  assert.equal(forced.stdout, "Stopped web (pid 4242): killed at once (--force). List: raft proc list\n");
  assert.deepEqual(forced.requests[1]!.body, { name: "web", force: true });
  assert.equal((await run(["proc", "stop", "web"], stop("already_exited", 10_000, job({ state: "exited", exitCode: 0 })))).stdout, "web had already exited (code 0). Logs: raft proc logs web\n");
  const missing = await run(["proc", "stop", "nope"], (method) => method === "GET" ? listing([]) : refused(404, "proc_not_found", "No job named nope; list them: raft proc list"));
  assert.match(missing.stderr, /^Error: No job named nope; list them: raft proc list\nCode: PROC_NOT_FOUND\n/);
});

test("logs: the tail with a header and the next commands; --tail is bounded", async () => {
  const result = await run(["proc", "logs", "web", "--tail", "2"], (method, pathname) => {
    if (pathname === "/internal/agent-api/proc") return listing([job()]);
    assert.equal(pathname, "/internal/agent-api/proc/logs?name=web&tail=2");
    return ok({ capability: "proc@1", job: job(), text: "two\nthree\n", offset: 14, rotated: false });
  });
  assert.equal(result.stdout, `web (running, pid 4242): last 2 lines of ${LOG}\ntwo\nthree\nFollow: raft proc logs web --follow · Stop: raft proc stop web\n`);
  const bad = await run(["proc", "logs", "web", "--tail", "0"], () => assert.fail("no request"));
  assert.match(bad.stderr, /--tail takes a number of lines from 1 to 2000/);
});

test("logs --follow prints what arrives, stops at the time limit and points at --tail; it ends early when the job exits", async () => {
  const stdout: string[] = [];
  let clock = 0;
  let polls = 0;
  const ctx = (exitAfter: number | null) => createCommandContext({
    io: { stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } }, stderr: { write: () => true } },
    loadAgentContext: () => managed,
    createApiClient: () => ({
      request: async (_method: string, pathname: string): Promise<Reply> => {
        if (pathname === "/internal/agent-api/proc") return listing([job()]);
        if (pathname.includes("tail=")) return ok({ capability: "proc@1", job: job(), text: "a\n", offset: 2, rotated: false });
        polls += 1;
        const exited = exitAfter !== null && polls >= exitAfter;
        return ok({ capability: "proc@1", job: exited ? job({ state: "exited", exitCode: 0 }) : job(), text: `p${polls}\n`, offset: 2 + polls * 3, rotated: false });
      },
    }) as never,
  });
  const deps = { followMs: 1_000, pollMs: 250, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  await runProcLogs(ctx(null), "web", { follow: true }, deps);
  assert.equal(stdout.join(""), `web (running, pid 4242): last 1 line of ${LOG}\na\np1\np2\np3\np4\nStopped following after 30 s. More: raft proc logs web --tail 100\n`);

  stdout.length = 0;
  clock = 0;
  polls = 0;
  await runProcLogs(ctx(2), "web", { follow: true }, deps);
  assert.equal(stdout.join(""), `web (running, pid 4242): last 1 line of ${LOG}\na\np1\np2\nweb exited (code 0). More: raft proc logs web --tail 100\n`);
});

test("raft proc is a visible command with its four actions", async () => {
  const program = buildRaftProgram();
  const proc = program.commands.find((command) => command.name() === "proc");
  assert.ok(proc);
  assert.deepEqual(proc.commands.map((command) => command.name()), ["start", "list", "logs", "stop"]);
});
