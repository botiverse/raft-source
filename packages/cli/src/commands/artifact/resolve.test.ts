// `raft artifact resolve` / `reopen` (#249) through the real parser: the
// thread and --note reach the request, a missing comment is refused before
// any request, the answers and refusals are the shared text with a next step
// (how the thread's author hears of it, #proj-workspace:#340), `raft artifact comments` marks
// resolved threads and lists open ones, and `--held` lists a hold's comments
// again.
import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import type { CliIo } from "../../core/io";
import { buildRaftProgram } from "../../program";
import { RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

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
/** A refusal as the Server words it: its sentence, its structured next step, its details. */
const refusedSaying = (status: number, code: string, error: string, more: { next?: object; details?: Record<string, unknown> } = {}): ApiResponse<unknown> =>
  ({ ok: false, status, data: null, error, errorCode: code, errorBody: { error, code, ...more } }) as ApiResponse<unknown>;

test("resolve --note: the thread and the note reach the request; the answer says what was posted, who heard, and how to reopen", async () => {
  const r = await run(["artifact", "resolve", "pt_abc", "c_1", "--note", "Done in v13."], () => ok({
    artifact: artifactRef,
    comment: { ...root, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: sage },
    note: { ...root, id: "c_9", author: sage, version: 13, replyTo: "c_1", body: "Done in v13.", resolvedAt: null, resolvedBy: null },
    changed: true,
    notified: [{ actor: kirby, reason: "resolved", delivery: "inbox" }],
    notNotified: [],
  }));
  assert.equal(r.stderr, "");
  assert.deepEqual(r.requests, [{ method: "POST", path: `${BASE}/pt_abc/comments/c_1/resolve`, body: { note: "Done in v13." } }]);
  assert.equal(r.stdout, [
    `Resolved @Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc).`,
    "Your note is reply c_9 in the thread.",
    "@Kirby gets a notice with its next wake-up; this does not wake it. If you need it to act, @mention it.",
    "To reopen it: raft artifact reopen pt_abc c_1",
    "",
  ].join("\n"));
});

test("#proj-workspace:#340: resolve says how its author hears of it, by the Server's delivery: a person in Activity without an unread, nothing for your own thread, an agent that can't see it gets nothing, an older Server's line as it was", async () => {
  const resolvedBy = (by: typeof sage, notified: unknown[], author: { type: "agent" | "user"; name: string } = kirby) => run(["artifact", "resolve", "pt_abc", "c_1"], () => ok({
    artifact: artifactRef, comment: { ...root, author, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: by }, note: null, changed: true, notified, notNotified: [],
  }));
  const xxchan = { type: "user" as const, name: "xxchan" };
  const person = await resolvedBy(sage, [{ actor: xxchan, reason: "resolved", delivery: "activity" }], xxchan);
  assert.equal(person.stdout, [
    `Resolved @xxchan's thread c_1 on a.html (v12) of "Proto" (pt_abc).`,
    "@xxchan sees it in Activity; it is not marked unread.",
    "To reopen it: raft artifact reopen pt_abc c_1",
    "",
  ].join("\n"));
  const own = await resolvedBy(kirby, []);
  assert.equal(own.stdout, `Resolved @Kirby's thread c_1 on a.html (v12) of "Proto" (pt_abc).\nTo reopen it: raft artifact reopen pt_abc c_1\n`);
  const cantSee = await resolvedBy(sage, []);
  assert.ok(cantSee.stdout.includes("\n@Kirby gets no notice: it can't see the artifact.\n"), cantSee.stdout);
  // A Server before #340 gives no `delivery` (it pushed the notice): the line it always had.
  const older = await resolvedBy(sage, [{ actor: kirby, reason: "resolved" }]);
  assert.ok(older.stdout.includes("\nTold: @Kirby (the thread's author).\n"), older.stdout);
  assert.ok(!older.stdout.includes("wake-up"), older.stdout);
});

test("comments --held: the range reaches the request (with all and its start as the cursor, for older Servers); the list says what it is and pages with it", async () => {
  const listed = {
    artifact: artifactRef,
    view: "all",
    path: null,
    comments: [{ ...root, resolvedAt: null, resolvedBy: null }],
    nextCursor: "57",
    unseenVersionCount: 0,
  };
  const r = await run(["artifact", "comments", "pt_abc", "--held", "41..57"], () => ok({ ...listed, held: "41..57" }));
  assert.equal(r.stderr, "");
  assert.equal(r.requests.length, 1);
  const url = new URL(`https://raft.example${r.requests[0]!.path}`);
  assert.equal(url.pathname, `${BASE}/pt_abc/comments`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { all: "1", cursor: "41", held: "41..57" });
  assert.ok(r.stdout.startsWith(`The comments in "Proto" that a held command marked seen, again (oldest first):\n`), r.stdout);
  assert.ok(r.stdout.includes("More: raft artifact comments pt_abc --held 41..57 --cursor 57"), r.stdout);
  // A Server before it ignores `held`: said so.
  const older = await run(["artifact", "comments", "pt_abc", "--held", "41..57"], () => ok(listed));
  assert.ok(older.stdout.startsWith("This Server can't list them by range yet; these are all the comments after where that held command started.\n"), older.stdout);
  // Not a range: refused before any request.
  const malformed = await run(["artifact", "comments", "pt_abc", "--held", "41-57"], () => { throw new Error("no request expected"); });
  assert.deepEqual(malformed.requests, []);
  assert.notEqual(malformed.stderr, "");
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

  // The Server's own sentences and steps (#wg-ax:#13 P3).
  const isReply = "That comment is a reply: only a whole thread is resolved, by its first comment (c_1).";
  const reply = await run(["artifact", "resolve", "pt_abc", "c_9"], () => refusedSaying(409, "COMMENT_IS_REPLY", isReply, { next: RAFT_HINTS.artifactResolve({ artifact: "pt_abc", comment: "c_1" }), details: { comment: "c_9", thread: "c_1" } }));
  assert.ok(reply.stderr.startsWith(`Error: ${isReply}\nCode: COMMENT_IS_REPLY\nNext action: raft artifact resolve pt_abc c_1\n`), reply.stderr);

  const notResolver = "Only the thread's author, the artifact's author (or whoever manages it, when it's an agent), and the server's owners and admins can reopen a thread: to say it isn't done, reply in it instead (a reply reopens it).";
  const forbidden = await run(["artifact", "reopen", "pt_abc", "c_1"], () => refusedSaying(403, "FORBIDDEN", notResolver, { next: RAFT_HINTS.artifactComment({ artifact: "pt_abc", replyTo: "c_1" }), details: { reason: "not_resolver", title: "Proto", threadAuthor: kirby, author: { type: "user", name: "xxchan" } } }));
  assert.ok(forbidden.stderr.startsWith(`Error: ${notResolver}\nCode: FORBIDDEN\n`), forbidden.stderr);
  assert.ok(forbidden.stderr.includes("Next action: raft artifact comment pt_abc --reply-to c_1"), forbidden.stderr);
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
