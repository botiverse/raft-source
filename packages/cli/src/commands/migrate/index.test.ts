import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentApiMigrationResponse, AgentApiMigrationStatusResponse } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import {
  migrateExportCommand,
  migrateImportCommand,
  migrateReadyCommand,
  migrateStatusCommand,
} from "./index.js";

const AGENT_VISIBLE_MIGRATION_SEAM_RE = /SLOCK_AGENT_MIGRATION_CONTROL_SEAM|\/migration-control|migration-control|MIGRATION_GRANT_CREATION_NOT_EXPOSED/;

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function migration(
  overrides: Partial<AgentApiMigrationResponse["migration"]> = {},
): AgentApiMigrationResponse["migration"] {
  return {
    id: "migration-1",
    agentId: "agent-1",
    sourceMachineId: "machine-source",
    targetMachineId: "machine-target",
    state: "prep",
    manifestPath: null,
    manifestSha256: null,
    arrivalReportPath: null,
    arrivalReportSha256: null,
    abortReason: null,
    failureReason: null,
    prepDeadlineAt: "2026-07-08T03:10:00.000Z",
    transferDeadlineAt: "2026-07-08T04:00:00.000Z",
    arrivalDeadlineAt: "2026-07-08T04:10:00.000Z",
    readyAt: null,
    flippedAt: null,
    arrivedAt: null,
    completedAt: null,
    abortedAt: null,
    revision: 1,
    createdAt: "2026-07-08T03:00:00.000Z",
    updatedAt: "2026-07-08T03:00:00.000Z",
    ...overrides,
  };
}

async function runCommand<T>(
  response: ApiResponse<T>,
  run: (ctx: ReturnType<typeof createCommandContext>) => Promise<void> | void,
): Promise<{ stdout: string; stderr: string; requests: Array<{ method: string; path: string; body?: unknown }> }> {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return response as ApiResponse<unknown>;
      },
    }) as any,
  });

  await Promise.resolve(run(ctx));
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests };
}

async function collectFiles(dir: URL, suffixes: readonly string[]): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: URL[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) {
      out.push(...await collectFiles(child, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(child);
    }
  }
  return out;
}

test("migrate import rejects agent-initiated migration before calling the API", async () => {
  await assert.rejects(
    runCommand<AgentApiMigrationResponse>(
      { ok: true, status: 200, error: null, data: { migration: migration() } },
      (ctx) => migrateImportCommand.handler(ctx, {
        targetMachineId: "machine-target",
        prepDeadlineMs: "60000",
      }),
    ),
    (err: unknown) => {
      const actual = err as { code?: string; message?: string };
      assert.equal(actual.code, "MIGRATE_IMPORT_NOT_SUPPORTED");
      assert.match(actual.message ?? "", /Agent-initiated migration is not supported/);
      assert.match(actual.message ?? "", /human creator/);
      assert.match(actual.message ?? "", /migrateAgents/);
      assert.doesNotMatch(actual.message ?? "", /owner|admin/i);
      return true;
    },
  );
});

test("migrate status prints an empty active migration state", async () => {
  const result = await runCommand<AgentApiMigrationStatusResponse>(
    { ok: true, status: 200, error: null, data: { migration: null } },
    (ctx) => migrateStatusCommand.handler(ctx, {}),
  );

  assert.deepEqual(result.requests, [{
    method: "GET",
    path: "/internal/agent-api/migrations/current",
    body: undefined,
  }]);
  assert.equal(result.stdout, "No active migration.\n");
});

test("migrate ready hashes a readable manifest and submits the callback", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "raft-migrate-ready-"));
  try {
    const manifest = path.join(tmp, "MIGRATION-MANIFEST.json");
    await writeFile(manifest, JSON.stringify({ ok: true }), "utf8");
    const expectedSha = createHash("sha256").update(await readFile(manifest)).digest("hex");

    const result = await runCommand<AgentApiMigrationResponse>(
      {
        ok: true,
        status: 200,
        error: null,
        data: {
          migration: migration({
            state: "ready",
            manifestPath: manifest,
            manifestSha256: expectedSha,
            readyAt: "2026-07-08T03:02:00.000Z",
            revision: 2,
          }),
        },
      },
      (ctx) => migrateReadyCommand.handler(ctx, { manifest }),
    );

    assert.deepEqual(result.requests, [{
      method: "POST",
      path: "/internal/agent-api/migrations/ready",
      body: { manifestPath: manifest, manifestSha256: expectedSha },
    }]);
    assert.match(result.stdout, /Migration prep marked ready/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("migrate export rejects action-card preparation before calling the API", async () => {
  await assert.rejects(
    runCommand<{ messageId: string; metadata: unknown }>(
      {
        ok: true,
        status: 200,
        error: null,
        data: { messageId: "card-message-1", metadata: { kind: "action-card" } },
      },
      (ctx) => migrateExportCommand.handler(ctx, {
        mode: "forensic",
        target: "#ops",
        targetMachineId: "target-computer-1",
        prepDeadlineMs: "60000",
      }),
    ),
    (err: unknown) => {
      const actual = err as { code?: string; message?: string };
      assert.equal(actual.code, "MIGRATE_EXPORT_NOT_SUPPORTED");
      assert.match(actual.message ?? "", /Agent-initiated migration export is not supported/);
      assert.match(actual.message ?? "", /human creator/);
      assert.match(actual.message ?? "", /migrateAgents/);
      assert.doesNotMatch(actual.message ?? "", /owner|admin/i);
      return true;
    },
  );
});

test("migrate export does not surface server-suggested grant-control next actions", async () => {
  await assert.rejects(
    runCommand<{ messageId: string; metadata: unknown }>(
      {
        ok: false,
        status: 403,
        error: "Migration export is not available",
        data: null,
        suggestedNextAction: "Ask an owner to enable SLOCK_AGENT_MIGRATION_CONTROL_SEAM.",
      },
      (ctx) => migrateExportCommand.handler(ctx, {
        target: "#ops",
        targetComputer: "target-computer-1",
      }),
    ),
    (err: unknown) => {
      const actual = err as { message?: string; suggestedNextAction?: string };
      assert.match(actual.message ?? "", /Agent-initiated migration export is not supported/);
      assert.equal(actual.suggestedNextAction, undefined);
      assert.doesNotMatch(actual.message ?? "", AGENT_VISIBLE_MIGRATION_SEAM_RE);
      return true;
    },
  );
});

test("agent-visible migration help and manual do not expose harness grant-control seam", async () => {
  const files = [
    new URL("./index.ts", import.meta.url),
    ...await collectFiles(new URL("../../../../../manual/agent-knowledge/", import.meta.url), [".md"]),
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, AGENT_VISIBLE_MIGRATION_SEAM_RE, file.pathname);
  }
});
