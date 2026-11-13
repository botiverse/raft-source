import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import pg from "pg";

// Real-PostgreSQL proof for task #269 (prod incident 2026-09-29 16:35:44Z):
// pg-pool removes its own idle-client 'error' listener while a client is
// checked out, so when the server drops the connection while the client sits
// between queries, pg emits 'error' on the Client with no listener and the
// process dies ("Emitted 'error' event on Client instance", exit code 1).
//
// The crash is a process-level event, so the proof uses child processes:
// case A (no per-client handler) must DIE the same way prod did — that is the
// red tooth, and it fails against pre-fix wiring; case B (with the handler
// that attachPoolClientErrorHandler installs) must SURVIVE and log. The
// production wiring itself (every `new pg.Pool(` paired with
// attachPoolClientErrorHandler) is enforced statically by
// scripts/ci/pg-pool-error-handler-ratchet.ts.

const REAL_PG_URL_ENV = "PG_POOL_ERROR_HANDLER_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.PG_POOL_ERROR_HANDLER_REAL_PG_REQUIRED === "1";

const CHILD_SOURCE = String.raw`
import pg from "pg";
// Unguarded by design: this case must die the way prod did before the fix,
// proving pg's raw behavior (the incident shape). The guarded case is the
// sibling child file, which runs the real createPool wiring.
const pool = new pg.Pool({ connectionString: process.env.PG_POOL_ERROR_HANDLER_REAL_PG_URL, max: 2 });
const client = await pool.connect();
console.log("BACKEND_PID", client.processID);
// Held between queries — the exact prod crash window. Never released.
setInterval(() => {}, 1000);
`;

type ChildResult = { exitCode: number | null; stdout: string; stderr: string; alive: boolean };

// The guarded case runs the REAL production wiring: the child imports
// createPool from db/index.ts via the repo's own TS loader, so deleting the
// helper body or the attach call turns case B red (Stone's review on #8690).
const GUARDED_CHILD_ARGS = [
  "--import", "@oxc-node/core/register",
  "src/db/pgPoolErrorHandler.realPg.child.ts",
];

async function runChild(mode: "unguarded" | "guarded", adminUrl: string): Promise<ChildResult> {
  const args = mode === "guarded" ? GUARDED_CHILD_ARGS : ["--input-type=module", "-e", CHILD_SOURCE];
  const child = spawn(process.execPath, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Capture exit/close from spawn time. A child that crashes before the
  // terminate query completes would exit before any listener below attaches,
  // and the waiter would fall through to its timer and report null (CI flake:
  // stderr held the expected crash while exitCode read null). 'close' fires
  // after stdio streams flush, so output is complete before assertions read it.
  const closePromise = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

  const backendPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never reported a backend pid; stdout=${stdout} stderr=${stderr}`)), 15_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/BACKEND_PID (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited ${code} before reporting a pid; stderr=${stderr}`)); });
  });

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const terminated = await admin.query<{ pg_terminate_backend: boolean }>(
      "SELECT pg_terminate_backend($1)", [backendPid],
    );
    assert.equal(terminated.rows[0]?.pg_terminate_backend, true, "server must confirm backend termination");
  } finally {
    await admin.end();
  }

  if (mode === "unguarded") {
    // The unguarded process must die from the unhandled 'error' event.
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      closePromise.then((code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode === null) child.kill("SIGKILL");
    return { exitCode, stdout, stderr, alive: exitCode === null };
  }

  // The guarded process must still be alive after the connection is gone.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const alive = child.exitCode === null && !child.killed;
  if (alive) {
    child.kill("SIGKILL");
    await closePromise;
  }
  return { exitCode: child.exitCode, stdout, stderr, alive };
}

test(
  "pg-pool checked-out client without an 'error' listener dies on connection drop; guarded pool survives (task #269)",
  { timeout: 60_000 },
  async (t) => {
    if (!REAL_PG_URL) {
      if (REAL_PG_REQUIRED) assert.fail(`${REAL_PG_URL_ENV} is required in this job`);
      t.skip(`set ${REAL_PG_URL_ENV} to run against real PostgreSQL`);
      return;
    }

    const unguarded = await runChild("unguarded", REAL_PG_URL);
    assert.equal(
      unguarded.exitCode,
      1,
      `unguarded child must exit 1 (the prod crash shape); got ${unguarded.exitCode}; stderr=${unguarded.stderr}`,
    );
    assert.match(
      unguarded.stderr,
      /'error' event/,
      `unguarded child must die from an unhandled 'error' event; stderr=${unguarded.stderr}`,
    );

    const guarded = await runChild("guarded", REAL_PG_URL);
    assert.equal(
      guarded.alive,
      true,
      `guarded child (real createPool wiring) must survive the dropped checked-out connection; stderr=${guarded.stderr}`,
    );
    assert.match(
      guarded.stderr + guarded.stdout,
      /checked-out connection/,
      `guarded child must log the captured client error via attachPoolClientErrorHandler; stdout=${guarded.stdout} stderr=${guarded.stderr}`,
    );
  },
);
