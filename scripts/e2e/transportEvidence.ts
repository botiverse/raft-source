/** E2E-only, opt-in evidence. Never import this into the application server. */
import { randomUUID } from "node:crypto";
import { errorMonitor } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";

export const SEGMENT_BYTES = 256 * 1024;
export const CLIENT_SLOTS = 16;
export const REQUEST_ID_HEADER = "x-e2e-login-request-id";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REQUEST_ID = /^e2e-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

let warned = false;
function warnUnavailable() {
  if (warned) return;
  warned = true;
  console.error("[e2e-transport] collection incomplete or unavailable; cause remains undetermined");
}

export type EvidenceConfig = { directory: string; runId: string };
type Fields = {
  requestId?: string | null;
  connectionId?: number;
  retry?: number;
  workerIndex?: number;
  parallelIndex?: number;
  status?: number;
  code?: string;
  hadError?: boolean;
  finished?: boolean;
  exitCode?: number;
};

/** Explicit allowlist; exception messages can contain headers/passwords. */
function errorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EADDRINUSE"].includes(code)
      ? code : "unknown";
  } catch {
    return "unknown";
  }
}

export function evidenceConfig(env = process.env): EvidenceConfig | undefined {
  const directory = env.SLOCK_E2E_TRANSPORT_DIR;
  const runId = env.SLOCK_E2E_TRANSPORT_RUN_ID;
  return directory && path.isAbsolute(directory) && runId && UUID.test(runId) ? { directory, runId } : undefined;
}

/** One invocation only. The runner supplies a fixed dedicated artifact subdirectory. */
export function prepareTransportEvidence(directory: string): EvidenceConfig | undefined {
  try {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    return { directory, runId: randomUUID() };
  } catch {
    warnUnavailable();
    return undefined;
  }
}

/** Single writer per slot: Playwright replaces a failed worker before reusing its parallelIndex. */
export function createEvidenceWriter(config: EvidenceConfig, slot: string) {
  const instanceId = randomUUID();
  const file = path.join(config.directory, `${slot}.jsonl`);
  let sequence = 0;
  let disabled = false;
  return (event: string, fields: Fields = {}) => {
    if (disabled) return false;
    try {
      // Only projected diagnostic fields reach disk, never arbitrary error or HTTP objects.
      const line = JSON.stringify({
        version: 1, runId: config.runId, instanceId, pid: process.pid,
        sequence: ++sequence, time: new Date().toISOString(), event,
        ...fields,
      }) + "\n";
      if (Buffer.byteLength(line) > 2048) return false;
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size + Buffer.byteLength(line) > SEGMENT_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      disabled = true;
      warnUnavailable();
      return false;
    }
  };
}

/** No signal handlers or uncaughtException handler: retain Node's exit semantics. */
export function observeApiProcess(config: EvidenceConfig | undefined) {
  if (!config) return undefined;
  const emit = createEvidenceWriter(config, "server");
  emit("process_start");
  process.on("exit", (exitCode) => { emit("process_exit", { exitCode }); });
  process.on("uncaughtExceptionMonitor", (error) => { emit("process_uncaught", { code: errorCode(error) }); });
  return (server: Server) => {
    let nextConnectionId = 0;
    const ids = new WeakMap<object, number>();
    server.on("listening", () => { emit("listener_listening"); });
    server.on("close", () => { emit("listener_close"); });
    // errorMonitor observes without swallowing an otherwise fatal unhandled 'error'.
    server.on(errorMonitor, (error) => { emit("listener_error", { code: errorCode(error) }); });
    server.on("connection", (socket) => {
      const connectionId = ++nextConnectionId;
      ids.set(socket, connectionId);
      emit("connection_open", { connectionId });
      socket.on(errorMonitor, (error) => { emit("connection_error", { connectionId, code: errorCode(error) }); });
      socket.on("close", (hadError) => { emit("connection_close", { connectionId, hadError }); });
    });
    server.prependListener("request", (request, response) => {
      if (request.method !== "POST" || request.url !== "/api/auth/login") return;
      const candidate = request.headers[REQUEST_ID_HEADER];
      const requestId = typeof candidate === "string" && REQUEST_ID.test(candidate) ? candidate : null;
      const fields = { requestId, connectionId: ids.get(request.socket) };
      emit("login_arrival", fields);
      request.on("aborted", () => { emit("login_aborted", fields); });
      response.on("finish", () => { emit("login_finish", { ...fields, status: response.statusCode }); });
      response.on("close", () => { emit("login_close", { ...fields, finished: response.writableFinished }); });
    });
  };
}

export type LoginAttempt = { retry: number; workerIndex: number; parallelIndex: number };

/** Pin only the first failing login in each slot; later chatter cannot overwrite it. */
function pinFirstFailure(config: EvidenceConfig, slot: string, fields: Fields, clientRecorded: boolean) {
  const marker = path.join(config.directory, `first-failure-${slot}.json`);
  try {
    if (existsSync(marker)) return;
    const copied: string[] = [];
    for (const suffix of ["", ".1"]) {
      const source = path.join(config.directory, `server.jsonl${suffix}`);
      if (existsSync(source) && statSync(source).size <= SEGMENT_BYTES) {
        const name = `first-failure-${slot}-server.jsonl${suffix}`;
        copyFileSync(source, path.join(config.directory, name));
        copied.push(name);
      }
    }
    writeFileSync(marker, JSON.stringify({
      runId: config.runId, ...fields, time: new Date().toISOString(), clientRecorded,
      serverSnapshots: copied, interpretation: "partial evidence; missing events do not establish a cause",
    }) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    warnUnavailable();
  }
}

/** Wrap exactly one existing login, preserving the result or the original thrown object. */
export async function observeLogin<T>(
  config: EvidenceConfig | undefined,
  attempt: LoginAttempt | undefined,
  login: (headers: Record<string, string> | undefined) => Promise<T>,
): Promise<T> {
  if (!config || (attempt && (!Number.isInteger(attempt.parallelIndex) || attempt.parallelIndex < 0 || attempt.parallelIndex >= CLIENT_SLOTS))) {
    return login(undefined);
  }
  const slot = attempt ? `client-${attempt.parallelIndex}` : "client-setup";
  const emit = createEvidenceWriter(config, slot);
  const requestId = `e2e-${randomUUID()}`;
  const fields = { requestId, ...attempt };
  emit("login_begin", fields);
  try {
    const result = await login({ [REQUEST_ID_HEADER]: requestId });
    emit("login_success", fields);
    return result;
  } catch (error) {
    const recorded = emit("login_failure", { ...fields, code: errorCode(error) });
    pinFirstFailure(config, slot, { ...fields, code: errorCode(error) }, recorded);
    throw error;
  }
}
