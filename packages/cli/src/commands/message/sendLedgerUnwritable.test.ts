// The agent ledger is loss-tolerant: when it cannot be written, `message send`
// still sends, and a hold says plainly that no draft was kept.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import { probeLedgerWritable, resolveStateDbPath } from "../../state/agentLedger";
import { messageSendCommand } from "./send";

const AGENT = "agent-ledger-unwritable";
const TARGET = "#room";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let ledgerDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-ledger-ro-"));
  process.env.SLOCK_CLI_STATE_DIR = path.join(root, "state");
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = path.join(root, "state");
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = path.join(root, "state");
  process.env.RAFT_HOME = root;
  delete process.env.SLOCK_CLI_TRANSPORT_DIR;
  // A real ledger, then -wal/-shm left behind by another process, then the
  // whole directory made read-only (the shape seen on the bench).
  assert.equal(probeLedgerWritable(AGENT), true);
  const dbPath = resolveStateDbPath(AGENT);
  const child = spawnSync(process.execPath, ["-e", [
    "const { DatabaseSync } = require('node:sqlite');",
    `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
    "db.exec(\"INSERT OR REPLACE INTO meta VALUES ('k', '1');\");",
    "process.exit(0);",
  ].join("\n")]);
  assert.equal(child.status, 0, String(child.stderr));
  ledgerDir = path.dirname(dbPath);
  for (const name of fs.readdirSync(ledgerDir)) fs.chmodSync(path.join(ledgerDir, name), 0o400);
  fs.chmodSync(ledgerDir, 0o500);
});
afterEach(() => {
  fs.chmodSync(ledgerDir, 0o700);
  for (const name of fs.readdirSync(ledgerDir)) fs.chmodSync(path.join(ledgerDir, name), 0o600);
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

async function send(response: Record<string, unknown>): Promise<{ requests: number; contextReads: number; stdout: string; error?: CliError }> {
  let requests = 0;
  // A held send reads the agent context for the continuation pilot flag; this Server has none.
  let contextReads = 0;
  let stdout = "";
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["hello\n"]),
      stdout: { write: (chunk: unknown) => { stdout += String(chunk); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (_method: string, path: string) => {
        if (path === "/internal/agent-api/context") {
          contextReads += 1;
          return { ok: false, status: 404, error: "not found", errorCode: null, data: null };
        }
        requests += 1;
        return { ok: true, status: 200, error: null, data: { ok: true, messageId: "m1", ...response } };
      },
    }) as never,
  });
  try {
    await messageSendCommand.handler(ctx, [], { target: TARGET });
    return { requests, contextReads, stdout };
  } catch (err) {
    return { requests, contextReads, stdout, error: err as CliError };
  }
}

test.skipIf(process.getuid?.() === 0)("an unwritable ledger does not stop a send", async () => {
  const r = await send({ state: "sent" });
  assert.equal(r.error, undefined, String(r.error?.message));
  assert.equal(r.requests, 1);
});

test.skipIf(process.getuid?.() === 0)("a hold on an unwritable ledger says no draft was kept", async () => {
  const r = await send({ state: "held", held: { latestMessages: [], unreadCount: 1 } });
  assert.equal(r.requests, 1);
  assert.equal(r.contextReads, 1, "the pilot flag, read once the send was held (unreadable here: the draft flow)");
  assert.equal(r.error?.code, "SEND_HELD");
  assert.equal(r.error?.draftSaved, false);
  assert.match(r.stdout, /no draft was kept/);
  assert.doesNotMatch(r.stdout, /--send-draft/, "never point at a draft that does not exist");
});
