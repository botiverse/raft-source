// `raft artifact settle` / `unsettle` (#334) through the real parser: the
// artifact reaches the request, the answers are the shared text (settled,
// already settled, Working again), and a server without Settled (the flag
// off, or no route at all) says so with Code: SETTLED_NOT_AVAILABLE.
import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import type { CliIo } from "../../core/io";
import { buildRaftProgram } from "../../program";

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};
const BASE = "/internal/agent-api/artifacts";
const sage = { type: "agent" as const, name: "Sage" };
const xxchan = { type: "user" as const, name: "xxchan" };
const summary = {
  id: "pt_abc",
  url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u",
  title: "Proto",
  description: null,
  kind: "html",
  home: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#proj-workspace" } },
  currentVersion: 12,
  author: sage,
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-22T14:02:00.000Z",
};

type Reply = (method: string, path: string, body?: unknown) => ApiResponse<unknown>;

async function run(argv: string[], reply: Reply) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  };
  const program = buildRaftProgram({
    io,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
        requests.push({ method, path, ...(body === undefined ? {} : { body }) });
        return reply(method, path, body) as ApiResponse<T>;
      },
    }) as any,
  });
  await program.parseAsync(argv, { from: "user" }).catch(() => undefined);
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests };
}

const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, data, error: null });
const refusedSaying = (status: number, code: string | null, error: string): ApiResponse<unknown> =>
  ({ ok: false, status, data: null, error, errorCode: code, errorBody: code === null ? { error } : { error, code } }) as ApiResponse<unknown>;

test("settle: the artifact reaches the request; the answer says it is settled at which version, or was already", async () => {
  const settled = await run(["artifact", "settle", "pt_abc"], () => ok({
    artifact: { ...summary, settled: { by: sage, at: "2026-11-19T15:30:00.000Z", version: 12 }, reopened: null },
    changed: true,
    newlySubscribed: false,
    notified: [],
  }));
  assert.equal(settled.stderr, "");
  assert.deepEqual(settled.requests, [{ method: "POST", path: `${BASE}/pt_abc/settle` }]);
  assert.equal(settled.stdout, `Settled "Proto" at v12.\n`);

  const again = await run(["artifact", "settle", "--artifact", "pt_abc"], () => ok({
    artifact: { ...summary, settled: { by: xxchan, at: "2026-11-18T16:20:00.000Z", version: 12 }, reopened: null },
    changed: false,
    newlySubscribed: false,
    notified: [],
  }));
  assert.equal(again.stdout, `"Proto" was settled already by @xxchan on 2026-11-18 at v12: nothing changed.\n`);
});

test("unsettle: Working again, or already", async () => {
  const working = await run(["artifact", "unsettle", "pt_abc"], () => ok({ artifact: { ...summary, settled: null, reopened: null }, changed: true, newlySubscribed: false, notified: [] }));
  assert.deepEqual(working.requests, [{ method: "POST", path: `${BASE}/pt_abc/unsettle` }]);
  assert.equal(working.stdout, `"Proto" is Working again.\n`);
  const already = await run(["artifact", "unsettle", "pt_abc"], () => ok({ artifact: { ...summary, settled: null, reopened: null }, changed: false, newlySubscribed: false, notified: [] }));
  assert.equal(already.stdout, `"Proto" is Working already: nothing changed.\n`);
});

test("a server without Settled: the flag off, or no route at all, both say so with its code", async () => {
  const off = await run(["artifact", "settle", "pt_abc"], () => refusedSaying(404, "SETTLED_NOT_AVAILABLE", "Settling isn't turned on for this artifact's server, so it can't be marked settled or unsettled here: nothing changed."));
  assert.ok(off.stderr.startsWith(`Error: Settling artifacts isn't turned on for "pt_abc"'s server. Nothing changed.\nCode: SETTLED_NOT_AVAILABLE\n`), off.stderr);
  const older = await run(["artifact", "unsettle", "pt_abc"], () => refusedSaying(404, null, "Not found"));
  assert.ok(older.stderr.startsWith(`Error: Settling artifacts isn't turned on for "pt_abc"'s server, so there is nothing to unsettle. Nothing changed.\nCode: SETTLED_NOT_AVAILABLE\n`), older.stderr);
});

test("one artifact only: no request for a missing or an extra argument", async () => {
  const missing = await run(["artifact", "settle"], () => ok({}));
  assert.deepEqual(missing.requests, []);
  const extra = await run(["artifact", "settle", "pt_abc", "pt_def"], () => ok({}));
  assert.deepEqual(extra.requests, []);
});
