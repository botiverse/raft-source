/**
 * Runs a real CLI command from argv against a recording fake Agent API, for
 * the phase-1 behaviour pins (see registryPin.test.ts). The program is the
 * binary's own (buildRaftProgram from program.ts): same root options, groups,
 * help text and parse-stage error mapping (runRaftArgv), with io, env, agent
 * context and API client injected. Help wraps at a fixed 80 columns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ApiResponse, BinaryResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { buildRaftProgram, runRaftArgv } from "../../program";

export const PIN_AGENT: AgentContext = {
  agentId: "agent-pin",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

export interface FakeRoute {
  method?: string;
  /** Matched against the request path (with query). */
  path: RegExp;
  /** Response data, or a full response for failures. */
  data?: unknown;
  response?: ApiResponse<unknown>;
  /** A binary route's bytes (a screenshot, a file); `response` still answers a failure. */
  bytes?: Uint8Array;
}

export interface PinRun {
  requests: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const STATE_ENV = [
  "SLOCK_HOME",
  "RAFT_HOME",
  "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR",
  "SLOCK_CLI_DRAFT_STATE_DIR",
  "SLOCK_CLI_STATE_DIR",
] as const;

/** Fresh, empty local CLI state for every run, so pins never depend on order. */
function isolateLocalState(): () => void {
  const saved = STATE_ENV.map((key) => [key, process.env[key]] as const);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-registry-pin-"));
  for (const key of STATE_ENV) process.env[key] = path.join(dir, key.toLowerCase());
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

export const PIN_MANAGED_AGENT: AgentContext = {
  ...PIN_AGENT,
  token: "proxy-token",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-file",
};

export interface PinOptions {
  /** Agent context the command loads (default PIN_AGENT, an external self-hosted runner). */
  agent?: AgentContext;
  /** Also record request headers (only requests that set any). */
  recordHeaders?: boolean;
}

export async function runPinned(
  argv: string[],
  routes: FakeRoute[],
  stdin?: string,
  options: PinOptions = {},
): Promise<PinRun> {
  const restore = isolateLocalState();
  try {
    return await runInCurrentState(argv, routes, stdin, options);
  } finally {
    restore();
  }
}

/** Runs one argv in the shared state of a `runPinnedSequence`. */
export type PinStepRunner = (argv: string[], routes: FakeRoute[], stdin?: string) => Promise<PinRun>;

/**
 * Run several argv against ONE fresh local state, in order (for commands that
 * act on what an earlier command left behind, such as a saved draft). The
 * body decides each argv, so a later step can use an earlier step's output.
 */
export async function runPinnedSequence<T>(body: (run: PinStepRunner) => Promise<T>, options: PinOptions = {}): Promise<T> {
  const restore = isolateLocalState();
  try {
    return await body((argv, routes, stdin) => runInCurrentState(argv, routes, stdin, options));
  } finally {
    restore();
  }
}

async function runInCurrentState(
  argv: string[],
  routes: FakeRoute[],
  stdin: string | undefined,
  options: PinOptions,
): Promise<PinRun> {
  const run: PinRun = { requests: [], stdout: "", stderr: "", exitCode: 0 };
  const agent = options.agent ?? PIN_AGENT;
  const io = {
    stdin: stdin === undefined ? Object.assign(Readable.from([]), { isTTY: true }) : Readable.from([stdin]),
    stdout: { write: (chunk: string) => { run.stdout += chunk; return true; } },
    stderr: { write: (chunk: string) => { run.stderr += chunk; return true; } },
  };
  const program = buildRaftProgram({
    io: io as never,
    env: {},
    loadAgentContext: () => agent,
    createApiClient: () => ({
      request: async (
        method: string,
        requestPath: string,
        body?: unknown,
        requestOptions?: { headers?: Record<string, string> },
      ): Promise<ApiResponse<unknown>> => {
        const headers = options.recordHeaders && requestOptions?.headers ? { headers: requestOptions.headers } : {};
        run.requests.push(body === undefined ? { method, path: requestPath, ...headers } : { method, path: requestPath, body, ...headers });
        const route = routes.find((r) => (!r.method || r.method === method) && r.path.test(requestPath));
        if (!route) return { ok: false, status: 404, error: `no fake route for ${method} ${requestPath}`, data: null } as never;
        return route.response ?? { ok: true, status: 200, error: null, data: route.data } as never;
      },
      requestBinary: async (method: string, requestPath: string): Promise<BinaryResponse> => {
        run.requests.push({ method, path: requestPath });
        const route = routes.find((r) => (!r.method || r.method === method) && r.path.test(requestPath));
        if (!route) return { ok: false, status: 404, body: null, error: `no fake route for ${method} ${requestPath}`, errorCode: null } as never;
        if (route.response && !route.response.ok) {
          return { ok: false, status: route.response.status, body: null, error: route.response.error, errorCode: route.response.errorCode ?? null } as never;
        }
        return { ok: true, status: 200, body: route.bytes ?? new Uint8Array(), error: null };
      },
    }) as never,
    helpWidth: 80,
  });
  run.exitCode = await runRaftArgv(program, ["node", "raft", ...argv], io as never);
  return run;
}

/** Replace values that are random per run (generated idempotency keys, temp dirs). */
export function scrub(run: PinRun): PinRun {
  const generated = new Set<string>();
  for (const request of run.requests) {
    const body = request.body as Record<string, unknown> | undefined;
    if (body && typeof body.idempotencyKey === "string") generated.add(body.idempotencyKey);
  }
  let text = JSON.stringify(run);
  for (const value of generated) text = text.split(value).join("<uuid>");
  text = text.replace(/[^"\s]*raft-registry-pin-[A-Za-z0-9]+/g, "<state-dir>");
  return JSON.parse(text) as PinRun;
}
