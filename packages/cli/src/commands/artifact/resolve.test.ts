// `raft artifact resolve` / `reopen` (#249) through the real parser: the
// thread and --note reach the request, a missing comment is refused before
// any request, the answers and refusals are the shared text with a next step,
// and `raft artifact comments` marks resolved threads and lists open ones.
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
const artifactRef = { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 13 };
const kirby = { type: "agent" as const, name: "Kirby" };
const sage = { type: "agent" as const, name: "Sage" };
const root = { id: "c_1", author: kirby, version: 12, path: "a.html", anchor: null, replyTo: null, body: "Put the states side by side.", createdAt: "2026-10-22T00:00:00.000Z", editedAt: null };

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
const refused = (status: number, code: string, details: Record<string, unknown>): ApiResponse<unknown> =>
  ({ ok: false, status, data: null, error: code, errorCode: code, errorBody: { error: code, code, details } }) as ApiResponse<unknown>;

test("resolve --note: the thread and the note reach the request; the answer says what was posted, who heard, and how to reopen", async () => {
  const r = await run(["artifact", "resolve", "pt_abc", "c_1", "--note", "Done in v13."], () => ok({
    artifact: artifactRef,
    comment: { ...root, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: sage },
    note: { ...root, id: "c_9", author: sage, version: 13, replyTo: "c_1", body: "Done in v13.", resolvedAt: null, resolvedBy: null },
    changed: true,
    notified: [{ actor: kirby, reason: "resolved" }],
    notNotified: [],
  }));
  assert.equal(r.stderr, "");
  assert.deepEqual(r.requests, [{ method: "POST", path: `${BASE}/pt_abc/comments/c_1/resolve`, body: { note: "Done in v13." } }]);
  assert.equal(r.stdout, [
    `Resolved @Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc).`,
    "Your note is reply c_9 in the thread.",
    "Told: @Kirby (the thread's author).",
    "To reopen it: raft artifact reopen pt_abc c_1",
    "",
  ].join("\n"));
});

test("resolve again: already resolved, nothing changed and no note; reopen without a body", async () => {
  const again = await run(["artifact", "resolve", "--artifact", "pt_abc", "c_1"], () => ok({
    artifact: artifactRef, comment: { ...root, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: sage }, note: null, changed: false, notified: [], notNotified: [],
  }));
  assert.deepEqual(again.requests, [{ method: "POST", path: `${BASE}/pt_abc/comments/c_1/resolve`, body: {} }]);
  assert.ok(again.stdout.startsWith(`@Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc) was resolved already by @Sage at `), again.stdout);
  assert.ok(again.stdout.includes("nothing changed, and no note was posted.\nTo reopen it: raft artifact reopen pt_abc c_1\n"), again.stdout);

  const reopened = await run(["artifact", "reopen", "pt_abc", "c_1"], () => ok({
    artifact: artifactRef, comment: { ...root, resolvedAt: null, resolvedBy: null }, note: null, changed: true, notified: [], notNotified: [],
  }));
  assert.deepEqual(reopened.requests, [{ method: "POST", path: `${BASE}/pt_abc/comments/c_1/reopen` }]);
  const open = await run(["artifact", "reopen", "pt_abc", "c_1"], () => ok({
    artifact: artifactRef, comment: { ...root, resolvedAt: null, resolvedBy: null }, note: null, changed: false, notified: [], notNotified: [],
  }));
  assert.ok(open.stdout.startsWith(`@Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc) is open already: nothing changed.\n`), open.stdout);
  assert.equal(reopened.stdout, `Reopened @Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc). No one was told.\nWhen it's answered: raft artifact resolve pt_abc c_1 --note "<what answered it>"\n`);
});

test("resolve: no comment is refused before any request; a reply and someone else's thread are refused with a next step", async () => {
  const missing = await run(["artifact", "resolve", "pt_abc"], () => { throw new Error("no request expected"); });
  assert.deepEqual(missing.requests, []);
  assert.ok(missing.stderr.includes("Name the thread to resolve") && missing.stderr.includes("raft artifact comments pt_abc --all"), missing.stderr);

  const reply = await run(["artifact", "resolve", "pt_abc", "c_9"], () => refused(409, "COMMENT_IS_REPLY", { comment: "c_9", thread: "c_1" }));
  assert.ok(reply.stderr.startsWith("Error: c_9 is a reply: only a whole thread is resolved, by its first comment (c_1).\nCode: COMMENT_IS_REPLY\nNext action: raft artifact resolve pt_abc c_1\n"), reply.stderr);

  const forbidden = await run(["artifact", "reopen", "pt_abc", "c_1"], () => refused(403, "FORBIDDEN", { reason: "not_resolver", title: "Proto", threadAuthor: kirby, author: { type: "user", name: "xxchan" } }));
  assert.ok(forbidden.stderr.startsWith(`Error: You can't reopen thread c_1 on "Proto": only the thread's author @Kirby, the artifact's author @xxchan (or whoever manages it, when it's an agent), and the server's owners and admins can.\nCode: FORBIDDEN\n`), forbidden.stderr);
  assert.ok(forbidden.stderr.includes("reply in it instead (that reopens it): raft artifact comment pt_abc --reply-to c_1"), forbidden.stderr);
});

test("comments --all: a resolved thread is marked status=resolved with who resolved it, and the open ones are listed with the resolve step", async () => {
  const r = await run(["artifact", "comments", "pt_abc", "--all"], () => ok({
    artifact: artifactRef,
    view: "all",
    path: null,
    comments: [
      { ...root, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: sage },
      { ...root, id: "c_9", author: sage, version: 13, replyTo: "c_1", body: "Done in v13.", resolvedAt: null, resolvedBy: null },
      { ...root, id: "c_2", path: null, body: "And the title?", resolvedAt: null, resolvedBy: null },
    ],
    nextCursor: null,
    unseenVersionCount: 0,
  }));
  assert.equal(r.stderr, "");
  assert.ok(r.stdout.includes("[comment=c_1 version=12 path=a.html status=resolved time="), r.stdout);
  assert.ok(r.stdout.includes("  Resolved by @Sage at "), r.stdout);
  assert.ok(!r.stdout.includes("comment=c_2 version=12 status=resolved"), r.stdout);
  assert.ok(r.stdout.includes("Resolved (status=resolved): c_1. A reply in one reopens it; to reopen one: raft artifact reopen pt_abc c_1"), r.stdout);
  assert.ok(r.stdout.includes(`Open threads: c_2. Once you've answered one (e.g. in a new version), resolve it, saying how: raft artifact resolve pt_abc c_2 --note "<what answered it>"`), r.stdout);
});
