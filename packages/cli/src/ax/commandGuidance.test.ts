// RFC 072 §7.7, CLI half (C1–C12): command guidance is delivered before the
// first run of a consequential command in each model context.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { defineCommand, registerCliCommand } from "../core/command";
import { CliExit } from "../core/errors";
import { probeLedgerWritable, resolveStateDbPath } from "../state/agentLedger";
import { readPassiveRenderCountsForTest } from "../state/passiveRenderCountsTestReader";
import { __setCliTraceSinkForTest, type CliTraceSpanRecord } from "../transportTrace";
import { attachGuidanceToHelp, GUIDANCE_HOLD_HEADER, MAX_GUIDANCE_CHARS, MAX_GUIDANCE_LINES } from "./commandGuidance";

const AGENT = "guidance-agent";
const GUIDANCE = "Assignment:\n  --assignee applies to every --title.\n  Self-assignment starts work.";

interface Seat {
  env: NodeJS.ProcessEnv;
  transportDir: string;
  setSignal(contextId: string | null, compactionReported?: boolean, passiveAx?: boolean | null): void;
}

function seat(overrides: Partial<NodeJS.ProcessEnv> = {}): Seat {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-guidance-"));
  const transportDir = path.join(root, "cli-transport", AGENT, "launch-1");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    SLOCK_AGENT_ID: AGENT,
    SLOCK_CLI_STATE_DIR: path.join(root, "state"),
    SLOCK_CLI_TRANSPORT_DIR: transportDir,
    RAFT_HOME: root,
    ...overrides,
  };
  return {
    env,
    transportDir,
    // passiveAx: null writes a record without the field (an older daemon).
    setSignal(contextId, compactionReported = true, passiveAx: boolean | null = true) {
      const file = path.join(transportDir, "context-generation");
      if (contextId === null) {
        fs.rmSync(file, { force: true });
        return;
      }
      const record = { contextId, reason: "spawn", compactionReported, runtime: "claude", writtenAt: "t", ...(passiveAx === null ? {} : { passiveAx }) };
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    },
  };
}

interface Run {
  executed: boolean;
  stdout: string;
  stderr: string;
  held: boolean;
}

/**
 * Runs `raft task create` through the real registration path. Flush callbacks
 * run synchronously unless `deferFlush` collects them for the caller.
 */
async function run(env: NodeJS.ProcessEnv, opts: { guidance?: string; deferFlush?: Array<() => void>; args?: string[]; failFlush?: boolean } = {}): Promise<Run> {
  let executed = false;
  let stdout = "";
  let stderr = "";
  const io = {
    stdin: process.stdin,
    stdout: {
      write: ((chunk: unknown, callback?: (error?: Error | null) => void) => {
        stdout += String(chunk);
        if (callback) {
          if (opts.deferFlush) opts.deferFlush.push(callback);
          else callback(opts.failFlush ? Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) : null);
        }
        return true;
      }) as NodeJS.WriteStream["write"],
    },
    stderr: { write: ((chunk: unknown) => { stderr += String(chunk); return true; }) as NodeJS.WriteStream["write"] },
  };
  const create = defineCommand(
    { name: "create", description: "Create tasks", guidance: opts.guidance ?? GUIDANCE },
    (ctx) => {
      executed = true;
      ctx.io.stdout.write("created\n");
    },
  );
  const program = new Command("raft").exitOverride();
  const task = program.command("task");
  registerCliCommand(task, create, { env, io } as never);
  let held = false;
  try {
    await program.parseAsync(["task", "create", ...(opts.args ?? [])], { from: "user" });
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    held = true;
  }
  return { executed, stdout, stderr, held };
}

async function help(env: NodeJS.ProcessEnv, guidance = GUIDANCE): Promise<string> {
  let out = "";
  const create = defineCommand({ name: "create", description: "Create tasks", guidance }, () => {});
  const program = new Command("raft").exitOverride();
  const task = program.command("task");
  registerCliCommand(task, create, { env } as never);
  task.commands[0]!.configureOutput({ writeOut: (chunk) => { out += chunk; } });
  await assert.rejects(program.parseAsync(["task", "create", "--help"], { from: "user" }));
  // The observation is recorded from the real stdout's flush callback.
  await new Promise((resolve) => setImmediate(resolve));
  return out;
}

test("C1 first use: nothing executes, not-executed line first, guidance, equivalent command, GUIDANCE_DELIVERED", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const first = await run(s.env);
  assert.equal(first.executed, false, "zero side effects");
  assert.equal(first.held, true, "non-zero exit");
  assert.equal(first.stdout, `${GUIDANCE_HOLD_HEADER}\n\n${GUIDANCE}\n\nEquivalent: raft task create --help\n`);
  assert.match(first.stderr, /Code: GUIDANCE_DELIVERED/);
});

test("C2 an unchanged re-run executes", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  await run(s.env);
  const second = await run(s.env);
  assert.equal(second.executed, true);
  assert.equal(second.stdout, "created\n", "no guidance once delivered in this context");
});

test("each guided run leaves one cli.guidance.decision span: the hold, then the re-run, with the same args hash and context (#wg-ax:#25)", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const spans: CliTraceSpanRecord[] = [];
  __setCliTraceSinkForTest((record) => { spans.push(record); });
  try {
    await run(s.env);
    await run(s.env);
  } finally {
    __setCliTraceSinkForTest(null);
  }
  const decisions = spans.filter((span) => span.name === "cli.guidance.decision");
  assert.deepEqual(decisions.map((span) => span.attrs.decision), ["hold", "pass"]);
  for (const span of decisions) {
    assert.equal(span.attrs.command, "task create");
    assert.equal(span.attrs.context_id, "ctx-A");
    assert.equal(span.attrs.agentId, AGENT);
    assert.match(String(span.attrs.args_hash), /^[0-9a-f]{16}$/);
  }
  assert.equal(decisions[0]!.attrs.args_hash, decisions[1]!.attrs.args_hash, "an unchanged re-run has the same hash");
});

test("C3 a new context, and C4 a changed guidance text, each hold once more", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  await run(s.env);
  s.setSignal("ctx-B");
  assert.equal((await run(s.env)).held, true, "C3: new contextId");
  assert.equal((await run(s.env)).executed, true);
  const reworded = `${GUIDANCE}\n  And one more thing.`;
  assert.equal((await run(s.env, { guidance: reworded })).held, true, "C4: new text version");
  assert.equal((await run(s.env, { guidance: reworded })).executed, true);
});

test("C5 --help delivers the guidance in full; the next run executes", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const text = await help(s.env);
  assert.ok(text.startsWith(`${GUIDANCE}\n`), "guidance leads the help, in full");
  assert.equal((await run(s.env)).executed, true);
});

test("C6 a context switch between decision and flush records under the decision's context", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const pending: Array<() => void> = [];
  await run(s.env, { deferFlush: pending });
  s.setSignal("ctx-B");
  for (const flush of pending) flush();
  // Recorded under ctx-A, so in ctx-B it is still undelivered.
  assert.equal((await run(s.env)).held, true);
});

test("C7 a runtime that does not report compaction: executes, guidance attached first, every time", async () => {
  const s = seat();
  s.setSignal("ctx-A", false);
  for (let i = 0; i < 2; i += 1) {
    const r = await run(s.env);
    assert.equal(r.executed, true);
    assert.equal(
      r.stdout,
      `Executed. Guidance attached: this runtime does not report context compaction, so it is shown on every use.\n${GUIDANCE}\n\ncreated\n`,
    );
  }
});

test("C8 no context signal, no transport dir or no agent identity: executes plainly", async () => {
  const s = seat();
  s.setSignal(null);
  const noSignal = await run(s.env);
  assert.deepEqual([noSignal.executed, noSignal.stdout], [true, "created\n"], "no record means the gate is off");

  const bridge = await run({ ...s.env, SLOCK_CLI_TRANSPORT_DIR: undefined });
  assert.deepEqual([bridge.executed, bridge.stdout], [true, "created\n"]);
  const human = await run({ ...s.env, SLOCK_AGENT_ID: undefined });
  assert.deepEqual([human.executed, human.stdout], [true, "created\n"]);
});

test("gate: passiveAx missing (older daemon) or false is today's behaviour, and nothing is booked", async () => {
  for (const passiveAx of [null, false] as const) {
    const s = seat();
    s.setSignal("ctx-A", true, passiveAx);
    const first = await run(s.env);
    assert.deepEqual([first.executed, first.stdout], [true, "created\n"], `passiveAx=${passiveAx}: no hold, no attach`);
    const helpText = await help(s.env);
    assert.ok(helpText.startsWith(GUIDANCE), "--help still prints the guidance before Usage");
    s.setSignal("ctx-A", true, true);
    assert.equal((await run(s.env)).held, true, "nothing was booked while the gate was off");
  }
});

test("gate: only a literal true turns it on", async () => {
  const s = seat();
  const file = path.join(s.transportDir, "context-generation");
  fs.writeFileSync(file, JSON.stringify({ contextId: "ctx-A", reason: "spawn", compactionReported: true, runtime: "claude", writtenAt: "t", passiveAx: "true" }), { mode: 0o600 });
  assert.deepEqual([(await run(s.env)).stdout], ["created\n"]);
});

test("C9 a ledger that cannot record the release attaches instead of holding", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  await run({ ...s.env, SLOCK_AGENT_ID: "other-agent" }); // create the ledger machinery once
  const db = new DatabaseSync((() => {
    const dbPath = resolveStateDbPath(AGENT, s.env);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return dbPath;
  })());
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT OR REPLACE INTO meta VALUES ('version', '99');");
  db.close();
  for (let i = 0; i < 2; i += 1) {
    const r = await run(s.env);
    assert.equal(r.executed, true, "never an unreleasable hold");
    assert.ok(r.stdout.startsWith("Executed. Guidance attached: this agent's local record cannot be written"));
  }
});

test.skipIf(process.getuid?.() === 0)("C9b a read-only ledger with WAL sidecars present attaches instead of holding", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  assert.equal(probeLedgerWritable(AGENT, s.env), true); // a real, fully migrated ledger
  const dbPath = resolveStateDbPath(AGENT, s.env);
  // Leave -wal/-shm behind, as a crashed or still-running process does. With
  // them present SQLite opens a read-only file in WAL read-only mode, where
  // BEGIN IMMEDIATE still succeeds and only a real write fails.
  const child = spawnSync(process.execPath, ["-e", [
    "const { DatabaseSync } = require('node:sqlite');",
    `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
    "db.exec(\"INSERT OR REPLACE INTO meta VALUES ('k', '1');\");",
    "process.exit(0);",
  ].join("\n")]);
  assert.equal(child.status, 0, String(child.stderr));
  assert.ok(fs.existsSync(`${dbPath}-wal`) && fs.existsSync(`${dbPath}-shm`), "sidecars left behind");
  const dir = path.dirname(dbPath);
  for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o400);
  fs.chmodSync(dir, 0o500);
  try {
    for (let i = 0; i < 2; i += 1) {
      const r = await run(s.env);
      assert.equal(r.executed, true, "never an unreleasable hold");
      assert.ok(r.stdout.startsWith("Executed. Guidance attached: this agent's local record cannot be written"));
    }
  } finally {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o600);
  }
});

test("a hold whose flush fails is not delivery: the next run holds again", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  assert.equal((await run(s.env, { failFlush: true })).held, true);
  assert.equal((await run(s.env)).held, true, "nothing reached the reader, so nothing was recorded");
  assert.equal((await run(s.env)).executed, true);
});

test("a --help whose flush fails (e.g. `| head` closed the pipe) is not delivery", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const program = new Command("raft").exitOverride();
  const create = program.command("task").command("create").exitOverride();
  attachGuidanceToHelp(create, GUIDANCE, {
    env: s.env,
    stdout: { write: ((_chunk: unknown, callback?: (error?: Error | null) => void) => {
      callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      return false;
    }) as NodeJS.WriteStream["write"] },
  });
  create.configureOutput({ writeOut: () => {} });
  assert.throws(() => program.parse(["task", "create", "--help"], { from: "user" }));
  assert.equal((await run(s.env)).held, true, "the guidance is taught again");
});

test("C10 the held guidance is byte-identical to the --help section", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const held = (await run(s.env)).stdout;
  const heldSection = held.slice(`${GUIDANCE_HOLD_HEADER}\n\n`.length, held.indexOf("\n\nEquivalent:"));
  const s2 = seat();
  const helpText = await help(s2.env);
  assert.equal(helpText.slice(0, heldSection.length), heldSection);
  assert.equal(heldSection, GUIDANCE);
});

test("C11 every command's guidance is within the limit, and registration rejects one that is not", async () => {
  const commandsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "commands");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(commandsDir);
  let withGuidance = 0;
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      const guidance = (value as { spec?: { guidance?: unknown } } | null)?.spec?.guidance;
      if (typeof guidance !== "string") continue;
      withGuidance += 1;
      assert.ok(guidance.split("\n").length <= MAX_GUIDANCE_LINES, `${file}: at most ${MAX_GUIDANCE_LINES} lines`);
      assert.ok(guidance.length <= MAX_GUIDANCE_CHARS, `${file}: at most ${MAX_GUIDANCE_CHARS} characters`);
    }
  }
  assert.ok(withGuidance >= 1, "task create carries guidance");

  const oversized = defineCommand({ name: "big", description: "x", guidance: "line\n".repeat(MAX_GUIDANCE_LINES + 1) }, () => {});
  assert.throws(() => registerCliCommand(new Command("raft"), oversized), /limit is 12 \/ 1200/);
});

test("C12 parallel first uses in one context are all held", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const pending: Array<() => void> = [];
  const [a, b] = await Promise.all([run(s.env, { deferFlush: pending }), run(s.env, { deferFlush: pending })]);
  assert.deepEqual([a.held, b.held], [true, true]);
  for (const flush of pending) flush();
  assert.equal((await run(s.env)).executed, true, "released once delivered");
});

test("a pre-release observations table without context_id gains the column and reads as not delivered", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const dbPath = resolveStateDbPath(AGENT, s.env);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE observations (type TEXT NOT NULL, id TEXT NOT NULL, rev TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (type, id));
    INSERT INTO observations VALUES ('command.guidance', 'task create', 'whatever', 1);`);
  db.close();
  assert.equal((await run(s.env)).held, true, "the old row has no context: not delivered here");
  assert.equal((await run(s.env)).executed, true, "and the release is recorded in the migrated table");
  const check = new DatabaseSync(dbPath);
  const rows = check.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
  check.close();
  assert.equal(Number(rows.n), 1, "migrated in place, not dropped");
});

test("held and attached guidance is counted for the daemon's turn report; --help and plain runs are not", async () => {
  const s = seat();
  s.setSignal("ctx-A");
  const held = await run(s.env);
  await run(s.env);
  await help(s.env);
  s.setSignal("ctx-B", false);
  const attached = await run(s.env);
  const attachedGuidance = attached.stdout.slice(0, -"created\n".length);
  assert.deepEqual(readPassiveRenderCountsForTest(AGENT, s.env), [
    { contextId: "ctx-A", kind: "command_guidance", renders: 1, chars: held.stdout.length, bytes: Buffer.byteLength(held.stdout, "utf8") },
    { contextId: "ctx-B", kind: "command_guidance", renders: 1, chars: attachedGuidance.length, bytes: Buffer.byteLength(attachedGuidance, "utf8") },
  ]);
});
