// `raft artifact save <attachment-id>` through the real parser: the request
// it sends, the shared text of the answer (saved, or the artifact an earlier
// save made), what is refused before any request (no id, more than one), and
// the Server's refusals in the shared words with their codes.
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
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
const PATH = "/internal/agent-api/artifacts/save-attachment";
const ATT = "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const summary = {
  id: "pt_def", url: "https://app.raft.build/artifacts/pt_def", name: "q3-report", title: "Q3 report", description: null, kind: "markdown",
  home: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 1,
  author: { type: "agent", name: "Remy" }, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z",
};
const noRequest = (): ApiResponse<unknown> => {
  throw new Error("no request expected");
};
const refusal = (status: number, code: string, details: Record<string, unknown>) => () => ({
  ok: false, status, data: null, error: code, errorCode: code, errorBody: { error: code, code, details },
}) as unknown as ApiResponse<unknown>;

async function run(argv: string[], reply: (method: string, path: string, body?: unknown) => ApiResponse<unknown>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const program = buildRaftProgram({
    io: {
      stdout: { write: (c: string | Uint8Array) => { stdout.push(String(c)); return true; } },
      stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } },
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
    },
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
        requests.push({ method, path, body });
        return reply(method, path, body) as ApiResponse<T>;
      },
    }) as any,
  });
  let error: unknown = null;
  await program.parseAsync(argv, { from: "user" }).catch((caught) => { error = caught; });
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests, error };
}

test("save: POST …/save-attachment { attachmentId }; the answer says where it lives, that the attachment links to it and you follow it, its link and how to revise it", async () => {
  const r = await run(["artifact", "save", ATT], () => ({
    ok: true, status: 201, data: { artifact: summary, created: true, attachment: { id: ATT, filename: "Q3 report.md" } }, error: null,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(r.requests, [{ method: "POST", path: PATH, body: { attachmentId: ATT } }]);
  assert.equal(
    r.stdout,
    `Saved Q3 report.md as "Q3 report" (pt_def) in #proj-workspace: whoever can see #proj-workspace can open it, and on the web the attachment now links to it. You follow it, so others' comments on it reach you.\n`
    + "Open: https://app.raft.build/artifacts/pt_def\n"
    + "Next: to revise it, pull it, edit, then push: raft artifact pull pt_def\n",
  );
});

test("save: one saved before answers that artifact, nothing new", async () => {
  const r = await run(["artifact", "save", ATT], () => ({
    ok: true, status: 200, data: { artifact: { ...summary, currentVersion: 3 }, created: false, attachment: { id: ATT, filename: "Q3 report.md" } }, error: null,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.equal(
    r.stdout,
    `Q3 report.md was already saved as "Q3 report" (pt_def); nothing new was made.\n`
    + "Open: https://app.raft.build/artifacts/pt_def\n"
    + "Next: read it, raft artifact read pt_def, or to revise it, pull it: raft artifact pull pt_def\n",
  );
});

test("save: no id, or more than one, is refused before any request", async () => {
  const none = await run(["artifact", "save"], noRequest);
  assert.equal(none.requests.length, 0);
  assert.ok(none.stderr.includes("Which attachment? Pass its id: raft message read shows it after the file name, as (id:<id>)") && none.stderr.includes("Code: INVALID_ARG"), none.stderr);
  const two = await run(["artifact", "save", ATT, "other"], noRequest);
  assert.equal(two.requests.length, 0);
  assert.ok(two.stderr.includes("Unexpected argument: other") && two.stderr.includes("Save one attachment at a time."), two.stderr);
});

test("save: the Server's refusals in the shared words, with their codes", async () => {
  const missing = await run(["artifact", "save", ATT], refusal(404, "ATTACHMENT_NOT_FOUND", { attachmentId: ATT }));
  assert.ok(missing.stderr.includes(`No attachment "${ATT}" that you can see.`) && missing.stderr.includes(`raft message read --target "<conversation>"`), missing.stderr);
  assert.ok(missing.stderr.includes(`If the id is right, raft attachment view ${ATT} --output <path> answers HISTORY_LIMITED`), missing.stderr);
  assert.ok(missing.stderr.includes("Code: ATTACHMENT_NOT_FOUND"), missing.stderr);
  const hidden = await run(["artifact", "save", ATT], refusal(409, "ALREADY_SAVED", { attachmentId: ATT }));
  assert.ok(hidden.stderr.includes("That attachment was already saved as an artifact you can't see; nothing new was made."), hidden.stderr);
  assert.ok(hidden.stderr.includes(`Push your own copy: mkdir <dir>, raft attachment view ${ATT} --output <dir>/<file name>`) && hidden.stderr.includes("Code: ALREADY_SAVED"), hidden.stderr);
  const big = await run(["artifact", "save", ATT], refusal(422, "ATTACHMENT_NOT_SAVABLE", { attachmentId: ATT, reason: "too_large", limit: 15 * 1024 * 1024 }));
  assert.ok(big.stderr.includes("larger than an artifact file may be (15 MiB for this kind of file)") && big.stderr.includes("Code: ATTACHMENT_NOT_SAVABLE"), big.stderr);
  const down = await run(["artifact", "save", ATT], refusal(503, "CONTENT_UNAVAILABLE", {}));
  assert.ok(down.stderr.includes(`Try again later: raft artifact save ${ATT}`) && down.stderr.includes("Code: CONTENT_UNAVAILABLE"), down.stderr);
});
