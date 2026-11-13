// `raft artifact review` and `raft artifact comments --review` through the
// real parser: the review comes from stdin as JSON, a JSON mistake is named by
// line and column, unknown fields are refused by name, a comment the Server
// refuses is named by its place (Comment N of M), and the answers are the
// shared text. Each run sends one idempotency key; a lost answer is sent once
// more under it, and a second loss gives the key for the next run. A
// comment's "images" (files) are checked before any request, uploaded in
// order, then posted with the review as ids (the same ids when it is sent
// again); a failure once one was uploaded, the review known not to be
// posted, says in a sentence of its own that those go unused.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { apiFailureError, proxyFailureNextAction } from "../../core/apiFailure";
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
const artifactRef = { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 };
const sage = { type: "agent" as const, name: "Sage" };
const review = { id: "rv_7", author: sage, version: 12, body: "Close; two things.", createdAt: "2026-10-27T18:30:00.000Z" };
const comment = (id: string, path: string | null, body: string, replyTo: string | null = null) => ({
  id, author: sage, version: 12, path, anchor: null, replyTo, body, createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_7",
});
const refusal = (status: number, code: string, details: Record<string, unknown>) => ({
  ok: false, status, data: null, error: code, errorCode: code, errorBody: { error: code, code, details },
}) as unknown as ApiResponse<unknown>;
const ok = (data: unknown, status = 201) => ({ ok: true, status, data, error: null }) as ApiResponse<unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The request's body without its generated key, and the key. */
function keyed(body: unknown): { body: Record<string, unknown>; key: unknown } {
  const { idempotencyKey, ...rest } = body as Record<string, unknown>;
  return { body: rest, key: idempotencyKey };
}
const never = (): ApiResponse<unknown> => { throw new Error("no request expected"); };

/** An image upload's answer (the raw-body route), by its place among the uploads (0-based). */
type UploadReply = (index: number) => ApiResponse<unknown>;

async function run(argv: string[], stdin: string | null, reply: (method: string, path: string, body?: unknown) => ApiResponse<unknown>, upload?: UploadReply) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown; bytes?: number[] }> = [];
  let uploads = 0;
  const input = stdin === null ? Object.assign(Readable.from([]), { isTTY: true }) : Readable.from([stdin]);
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    stdin: input,
  };
  const program = buildRaftProgram({
    io,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
        requests.push({ method, path, body });
        return reply(method, path, body) as ApiResponse<T>;
      },
      requestRawBody: async <T>(method: string, path: string, bytes: Uint8Array): Promise<ApiResponse<T>> => {
        requests.push({ method, path, bytes: [...bytes.subarray(0, 4)] });
        if (!upload) throw new Error("no upload expected");
        return upload(uploads++) as ApiResponse<T>;
      },
    }) as any,
  });
  let error: unknown = null;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests, error };
}

const REVIEW_JSON = JSON.stringify({
  body: "Close; two things.",
  comments: [
    { path: "components.html", body: "@Kirby the \"empty\" state is missing" },
    { replyTo: "c_812", body: "Side by side works." },
    { body: "Tech section reads well." },
  ],
}, null, 2);

test("review: the JSON from stdin reaches the request as given, with --rev; the answer names the review, its comments and who heard", async () => {
  const r = await run(["artifact", "review", "pt_abc", "--rev", "v12"], REVIEW_JSON, () => ok({
    artifact: artifactRef,
    review,
    comments: [comment("c_901", "components.html", "@Kirby the \"empty\" state is missing"), comment("c_902", "components.html", "Side by side works.", "c_812"), comment("c_903", null, "Tech section reads well.")],
    notified: [{ actor: { type: "agent", name: "Kirby" }, reason: "mentioned" }],
    notNotified: [],
    newlySubscribed: false,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.equal(r.requests.length, 1);
  assert.match(String(keyed(r.requests[0]!.body).key), UUID);
  assert.deepEqual(r.requests.map((q) => ({ ...q, body: keyed(q.body).body })), [{
    method: "POST",
    path: `${BASE}/pt_abc/reviews`,
    body: {
      body: "Close; two things.",
      version: 12,
      comments: [
        { body: "@Kirby the \"empty\" state is missing", path: "components.html" },
        { body: "Side by side works.", replyTo: "c_812" },
        { body: "Tech section reads well." },
      ],
    },
  }]);
  assert.equal(r.stdout, [
    `Posted a review of v12 of "Proto" (pt_abc): rv_7, 3 comments on components.html (2), the whole artifact, with a summary.`,
    "Comments, in order: c_901, c_902, c_903.",
    "Notified: @Kirby (mentioned). They'll see it in the artifact; no need to repeat it in a conversation.",
    "Each was told once, for the whole review.",
    "To read it back: raft artifact comments pt_abc --review rv_7",
    "",
  ].join("\n"));
});

test("review: just an array of comments is a review without a summary", async () => {
  const r = await run(["artifact", "review", "pt_abc"], `[{ "body": "One thing" }]`, () => ok({
    artifact: artifactRef, review: { ...review, body: null }, comments: [comment("c_901", null, "One thing")], notified: [], notNotified: [], newlySubscribed: true,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(keyed(r.requests[0]?.body).body, { comments: [{ body: "One thing" }] });
  assert.ok(r.stdout.includes("No one was notified. To bring someone in, @name them in a reply to one of the comments: raft artifact comment pt_abc --reply-to c_901"), r.stdout);
  assert.ok(r.stdout.includes(`You now follow "Proto"`), r.stdout);
});

test("review: nothing on stdin, bad JSON, or an unknown field is refused before any request, saying where and how to send it", async () => {
  const tty = await run(["artifact", "review", "pt_abc", "--rev", "3"], null, never);
  assert.ok(tty.stderr.includes("No review received on stdin.") && tty.stderr.includes(`raft artifact review pt_abc --rev 3 <<'REVIEW'`), tty.stderr);
  const broken = await run(["artifact", "review", "pt_abc"], `{\n  "comments": [\n    { "body": "a" }\n    { "body": "b" }\n  ]\n}`, never);
  assert.ok(broken.stderr.includes(`The review on stdin: it isn't valid JSON at line 4, column 5 (found "{"). Nothing was posted.`), broken.stderr);
  // The usual mistakes, which Node's own error places nowhere: a trailing comma, single quotes.
  const trailing = await run(["artifact", "review", "pt_abc"], `{ "comments": [\n  { "body": "a" },\n] }`, never);
  assert.ok(trailing.stderr.includes("it isn't valid JSON at line 3, column 1 (a comma before ])."), trailing.stderr);
  const quotes = await run(["artifact", "review", "pt_abc"], `{ "comments": [{ 'body': "a" }] }`, never);
  assert.ok(quotes.stderr.includes("it isn't valid JSON at line 1, column 18 (a single quote: JSON strings take double quotes)."), quotes.stderr);
  assert.ok(broken.stderr.includes("Nothing was posted.") && broken.stderr.includes(`"comments": [`), broken.stderr);
  const misspelt = await run(["artifact", "review", "pt_abc"], `{ "comments": [{ "body": "a" }, { "reply_to": "c_1", "body": "b" }] }`, never);
  assert.ok(misspelt.stderr.includes(`Comment 2 of 2 has "reply_to", which a comment doesn't take (it takes "body", "path", "replyTo" and "images").`), misspelt.stderr);
  const empty = await run(["artifact", "review", "pt_abc"], `{ "body": "summary only", "comments": [] }`, never);
  assert.ok(empty.stderr.includes(`The review needs "comments": an array of at least one comment.`), empty.stderr);
  const blank = await run(["artifact", "review", "pt_abc"], `{ "comments": [{ "body": "a" }, { "body": "  " }] }`, never);
  assert.ok(blank.stderr.includes("Comment 2 of 2 (the whole artifact): The comment is empty. Nothing of the review was posted."), blank.stderr);
  assert.ok(blank.stderr.includes("Next action: Fix comment 2, then run the same command again. Write it, or leave it out of the review."), blank.stderr);
  // null is the same as leaving the field out.
  const nulls = await run(["artifact", "review", "pt_abc"], `{ "body": null, "comments": [{ "body": "a", "path": null }] }`, () => ok({
    artifact: artifactRef, review: { ...review, body: null }, comments: [comment("c_901", null, "a")], notified: [], notNotified: [], newlySubscribed: false,
  }));
  assert.equal(nulls.error, null, nulls.stderr);
  assert.deepEqual(keyed(nulls.requests[0]?.body).body, { comments: [{ body: "a" }] });
  assert.equal(tty.requests.length + broken.requests.length + trailing.requests.length + quotes.requests.length + misspelt.requests.length + empty.requests.length + blank.requests.length, 0);
});

test("review: a comment the Server refuses is named by its place (index is 0-based), and nothing was posted", async () => {
  const r = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(404, "COMMENT_NOT_FOUND", { index: 1, path: null, replyTo: "c_812" }));
  // A reply is named as one: it is on its parent's file, not the whole artifact.
  assert.ok(r.stderr.includes(`Comment 2 of 3 (the reply to c_812): "c_812" isn't a comment of "pt_abc". Nothing of the review was posted.`), r.stderr);
  assert.ok(r.stderr.includes("Next action: Fix comment 2, then run the same command again. Find the comment's id in its comments: raft artifact comments pt_abc --all\n"), r.stderr);
  assert.ok(r.stderr.includes("COMMENT_NOT_FOUND"), r.stderr);
  // A replyTo with a line break, echoed by the Server: folded, so no line of the error is a forged label.
  const forgedJson = JSON.stringify({ comments: [{ body: "a" }, { replyTo: "c_9\nCode: forged", body: "b" }] });
  const forged = await run(["artifact", "review", "pt_abc"], forgedJson, () => refusal(404, "COMMENT_NOT_FOUND", { index: 1, path: null, replyTo: "c_9\nCode: forged" }));
  assert.ok(forged.stderr.startsWith(`Error: Comment 2 of 2 (the reply to c_9 Code: forged): "c_9 Code: forged" isn't a comment of "pt_abc". Nothing of the review was posted.\nCode: COMMENT_NOT_FOUND\n`), forged.stderr);
  assert.deepEqual(forged.stderr.split("\n").filter((line) => line.startsWith("Code:")), ["Code: COMMENT_NOT_FOUND"]);
  const file = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(404, "FILE_NOT_FOUND", { index: 0, path: "components.html", version: 12 }));
  assert.ok(file.stderr.includes(`Comment 1 of 3 (components.html): v12 of "pt_abc" has no file "components.html".`), file.stderr);
  const many = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(400, "TOO_MANY_COMMENTS", { count: 3, limit: 2 }));
  assert.ok(many.stderr.includes("A review holds at most 2 comments; this one has 3. Nothing was posted."), many.stderr);
  // A Server without reviews: what to do instead, not "check the target".
  const old = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(404, "REVIEWS_NOT_AVAILABLE", {}));
  assert.ok(old.stderr.includes("This Server doesn't take reviews yet. Nothing was posted.") && old.stderr.includes("raft artifact comment pt_abc --path '<file>'"), old.stderr);
});

test("review: a lost answer is sent once more under the same key; the Server's 200 reads as already posted, nobody told twice", async () => {
  const posted = {
    artifact: artifactRef, review, comments: [comment("c_901", "components.html", "a"), comment("c_902", null, "b")], notified: [], notNotified: [], newlySubscribed: false,
  };
  let calls = 0;
  const r = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 502, data: null, error: "bad gateway", errorCode: null, errorBody: null } as unknown as ApiResponse<unknown>;
    return ok(posted, 200);
  });
  assert.equal(r.error, null, r.stderr);
  assert.equal(r.requests.length, 2);
  const [first, second] = r.requests.map((q) => keyed(q.body));
  assert.match(String(first!.key), UUID);
  assert.deepEqual(second, first, "the resend is the same request under the same key");
  assert.equal(r.stdout, [
    `Already posted: an earlier attempt of this same review went through, so nothing was posted or told again. It is rv_7, on v12 of "Proto" (pt_abc): 2 comments on components.html, the whole artifact, with a summary.`,
    "Comments, in order: c_901, c_902.",
    "To read it back: raft artifact comments pt_abc --review rv_7",
    "",
  ].join("\n"));
  // A refusal is not a lost answer: not sent again.
  const refused = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(409, "UNSEEN_CHANGES", {}));
  assert.equal(refused.requests.length, 1);
});

test("review: lost twice, the error gives the key to run it with; the JSON's idempotencyKey is sent as given", async () => {
  const r = await run(["artifact", "review", "pt_abc", "--rev", "12"], REVIEW_JSON, () => { throw new Error("socket hang up"); });
  assert.equal(r.requests.length, 2);
  const key = String(keyed(r.requests[0]!.body).key);
  assert.equal(keyed(r.requests[1]!.body).key, key);
  assert.ok(r.stderr.includes("Error: No answer to the review, sent twice under one key (the last try: the connection failed), so it may or may not have been posted."), r.stderr);
  assert.ok(r.stderr.includes(`Run the same command with your same JSON, unchanged but for this line added, which posts the review only if it wasn't: "idempotencyKey": "${key}"`), r.stderr);
  assert.ok(r.stderr.includes(`raft artifact review pt_abc --rev 12 <<'REVIEW'`), r.stderr);
  const again = await run(["artifact", "review", "pt_abc"], JSON.stringify({ ...JSON.parse(REVIEW_JSON), idempotencyKey: ` ${key} ` }), () => ok({
    artifact: artifactRef, review, comments: [comment("c_901", null, "a")], notified: [], notNotified: [], newlySubscribed: false,
  }, 200));
  assert.equal(again.error, null, again.stderr);
  assert.equal(keyed(again.requests[0]!.body).key, key);
  assert.ok(again.stdout.startsWith("Already posted: "), again.stdout);
  const blankKey = await run(["artifact", "review", "pt_abc"], `{ "idempotencyKey": " ", "comments": [{ "body": "a" }] }`, never);
  assert.ok(blankKey.stderr.includes(`The review's "idempotencyKey" must be the key an earlier run gave (a string), or left out.`), blankKey.stderr);
  const reused = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(409, "IDEMPOTENCY_KEY_REUSED", {}));
  assert.ok(reused.stderr.includes("A review was already posted under that idempotencyKey, and this request differs from it (an edit, another --rev, or images uploaded again under new ids). Nothing more was posted."), reused.stderr);
  assert.ok(reused.stderr.includes(`See the review that was posted among your comments: raft artifact comments pt_abc --all. Only to post a second review, take "idempotencyKey" out of the JSON`), reused.stderr);
  assert.equal(reused.requests.length, 1);
});

test("review: a resend that is rate limited, or an answer that can't be read, keeps the key in play", async () => {
  const limited = { error: "This agent made too many artifact changes: the limit is 60 a minute. Retry in 23 seconds.", code: "RATE_LIMITED", details: { operation: "artifactReview", limit: 60, windowSeconds: 60, retryAfterSeconds: 23 } };
  let calls = 0;
  const r = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 502, data: null, error: "bad gateway", errorCode: null, errorBody: null } as unknown as ApiResponse<unknown>;
    return { ok: false, status: 429, data: null, error: limited.error, errorCode: "RATE_LIMITED", errorBody: limited } as unknown as ApiResponse<unknown>;
  });
  assert.equal(r.requests.length, 2);
  const key = String(keyed(r.requests[0]!.body).key);
  assert.ok(r.stderr.includes("(the last try: rate limited), so it may or may not have been posted."), r.stderr);
  assert.ok(r.stderr.includes(`Wait 23 seconds, then run the same command with your same JSON, unchanged but for this line added, which posts the review only if it wasn't: "idempotencyKey": "${key}"`), r.stderr);

  // A 201 whose body was cut off: the review went in; the resend under the key answers it.
  calls = 0;
  const cut = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 201, data: null, error: "Unexpected end of JSON input", errorCode: "INVALID_JSON_RESPONSE", errorBody: null } as unknown as ApiResponse<unknown>;
    return ok({ artifact: artifactRef, review, comments: [comment("c_901", null, "a")], notified: [], notNotified: [], newlySubscribed: false }, 200);
  });
  assert.equal(cut.error, null, cut.stderr);
  assert.equal(cut.requests.length, 2);
  assert.ok(cut.stdout.startsWith("Already posted: "), cut.stdout);
});

test("comments --review: the review and its summary, then its comments in order", async () => {
  const r = await run(["artifact", "comments", "pt_abc", "--review", "rv_7"], null, () => ok({
    artifact: artifactRef, view: "all", path: null, review,
    comments: [comment("c_901", "components.html", "@Kirby the empty state is missing"), comment("c_903", null, "Tech section reads well.")],
    nextCursor: null, unseenVersionCount: 0,
  }));
  assert.equal(r.error, null, r.stderr);
  // `all` too: a Server from before S8 ignores `review`, and then lists every comment without marking any seen.
  assert.deepEqual(r.requests.map((q) => q.path), [`${BASE}/pt_abc/comments?all=1&review=rv_7`]);
  assert.equal(r.stdout, [
    `Review rv_7 of "Proto" by @Sage on v12, 2026-10-27 18:30:00Z:`,
    "  │ Close; two things.",
    "Its comments, in order:",
    "[comment=c_901 version=12 path=components.html review=rv_7 time=2026-10-27 18:30:00Z] @Sage: @Kirby the empty state is missing",
    "[comment=c_903 version=12 review=rv_7 time=2026-10-27 18:30:00Z] @Sage: Tech section reads well.",
    "To answer one (comment on stdin), reply to its comment=… id: raft artifact comment pt_abc --reply-to c_901",
    "",
  ].join("\n"));
  const none = await run(["artifact", "comments", "pt_abc", "--review", "rv_x"], null, () => ok({
    artifact: artifactRef, view: "all", path: null, review: null, comments: [], nextCursor: null, unseenVersionCount: 0,
  }));
  assert.ok(none.stdout.startsWith(`No review rv_x in "Proto". Its review ids are on its comments (review=…): raft artifact comments pt_abc --all`), none.stdout);
  // A Server from before S8 answers no `review`: said so, not passed off as the review's comments.
  const old = await run(["artifact", "comments", "pt_abc", "--review", "rv_7"], null, () => ok({
    artifact: artifactRef, view: "all", path: null, comments: [comment("c_1", null, "older")], nextCursor: null, unseenVersionCount: 0,
  }));
  assert.ok(old.stdout.startsWith("This Server can't list one review's comments yet; these are the comments as listed without it.\nComments in \"Proto\" (oldest first):"), old.stdout);
});

// ── images (#146): each comment's "images" are files, checked before any request, uploaded in order, then the review ──

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const kept = (fileId: string, contentType: string) => ({ fileId, contentType, sizeBytes: 319_488, width: 1280, height: 800 });
const uploaded = (...images: Array<ReturnType<typeof kept>>): UploadReply => (index) => ({ ok: true, status: 201, data: images[index], error: null }) as ApiResponse<unknown>;

/** Run with the images in a fresh temp directory as the current directory, so `./a.png` is the path the agent wrote. */
async function inImageDir<T>(body: () => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "raft-artifact-review-images-")));
  const before = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync("a.png", new Uint8Array(PNG));
    writeFileSync("b.jpg", new Uint8Array(JPEG));
    writeFileSync("x.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    writeFileSync("big.png", new Uint8Array(PNG));
    // 12.4 MiB, sparse: its size is decided before anything is read.
    truncateSync("big.png", 13_002_342);
    mkdirSync("shots");
    return await body();
  } finally {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("review with images: every file uploaded in order as raw bytes, then the review with each comment's ids; an image alone needs no body; the receipt counts them", async () => {
  await inImageDir(async () => {
    const images = [kept("f-1", "image/png"), kept("f-2", "image/jpeg"), kept("f-3", "image/png")];
    const json = JSON.stringify({
      body: "Two screens",
      comments: [
        { path: "components.html", body: "before and after", images: ["./a.png", "./b.jpg"] },
        { body: "No image here" },
        { replyTo: "c_812", images: ["./a.png"] },
      ],
    });
    const r = await run(["artifact", "review", "pt_abc"], json, () => ok({
      artifact: artifactRef,
      review: { ...review, body: "Two screens" },
      comments: [
        { ...comment("c_901", "components.html", "before and after"), images: [images[0], images[1]] },
        comment("c_902", null, "No image here"),
        { ...comment("c_903", "components.html", "", "c_812"), images: [images[2]] },
      ],
      notified: [], notNotified: [], newlySubscribed: false,
    }), uploaded(...images));
    assert.equal(r.error, null, r.stderr);
    assert.deepEqual(r.requests.map((q) => ({ ...q, ...(q.body === undefined ? {} : { body: keyed(q.body).body }) })), [
      { method: "POST", path: `${BASE}/pt_abc/comment-images`, bytes: PNG.slice(0, 4) },
      { method: "POST", path: `${BASE}/pt_abc/comment-images`, bytes: JPEG.slice(0, 4) },
      { method: "POST", path: `${BASE}/pt_abc/comment-images`, bytes: PNG.slice(0, 4) },
      {
        method: "POST",
        path: `${BASE}/pt_abc/reviews`,
        body: {
          body: "Two screens",
          comments: [
            { body: "before and after", path: "components.html", images: ["f-1", "f-2"] },
            { body: "No image here" },
            { body: "", replyTo: "c_812", images: ["f-3"] },
          ],
        },
      },
    ]);
    assert.equal(r.stdout, [
      `Posted a review of v12 of "Proto" (pt_abc): rv_7, 3 comments on components.html (2), the whole artifact, with a summary.`,
      "Comments, in order: c_901 (+2 images), c_902, c_903 (1 image).",
      "No one was notified. To bring someone in, @name them in a reply to one of the comments: raft artifact comment pt_abc --reply-to c_901",
      "To read it back: raft artifact comments pt_abc --review rv_7",
      "",
    ].join("\n"));
  });
});

test("review with images: a file that can't go is refused before any request, naming its comment and the file; so are too many, and a malformed images field", async () => {
  await inImageDir(async () => {
    const review3 = (images: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ comments: [{ body: "a" }, { body: "b", path: "components.html" }, { path: "docs/a.html", body: "c", images, ...extra }] });
    const cases: Array<[string, string, string]> = [
      [review3(["./a.png", "./x.svg"]), "Comment 3 of 3 (docs/a.html): image ./x.svg is not a PNG, JPEG, WebP or GIF image (checked by its first bytes). Nothing of the review was posted.", "Fix comment 3, then run the same command again. Save it as a PNG, JPEG, WebP or GIF image (for an SVG or a PDF, a PNG screenshot of it)."],
      [review3(["./missing.png"]), "Comment 3 of 3 (docs/a.html): image ./missing.png can't be read (no such file). Nothing of the review was posted.", "Fix comment 3, then run the same command again. Check the path (relative to the directory you run the command in)."],
      [review3(["./big.png"]), "Comment 3 of 3 (docs/a.html): image ./big.png is 12.4 MiB; an image can be at most 10 MiB. Nothing of the review was posted.", "Fix comment 3, then run the same command again. Make it smaller (fewer pixels, or JPEG or WebP for a photo)."],
      [review3(["./shots"]), "Comment 3 of 3 (docs/a.html): image ./shots can't be read (it is a directory). Nothing of the review was posted.", "Fix comment 3, then run the same command again. Check the path (relative to the directory you run the command in)."],
      [review3(["./a.png", "./a.png", "./a.png", "./a.png", "./b.jpg"]), "Comment 3 of 3 (docs/a.html): A comment takes at most 4 images (5 given). Nothing of the review was posted.", "Fix comment 3, then run the same command again. Keep 4 in this comment and put the others in another comment of the review."],
      [JSON.stringify({ comments: Array.from({ length: 8 }, () => ({ body: "", images: ["./a.png", "./a.png", "./a.png", "./a.png"] })) }), "A review can carry at most 30 images (the most an agent may upload in a minute); this one has 32. Nothing was sent.", "Keep 30 in this review and post the others in a second review a minute later."],
      // Each comment and each image is one of the agent's writes a minute: 45 + 16 would be refused on every run.
      [JSON.stringify({ comments: Array.from({ length: 45 }, (_, i) => (i < 4 ? { body: "", images: ["./a.png", "./a.png", "./a.png", "./a.png"] } : { body: `note ${i}` })) }), "A review and its images can be at most 60 of an agent's writes a minute (one per comment and one per image); this one has 45 comments and 16 images, 61 in all. Nothing was sent.", "Keep 60 or fewer in this review and post the rest in a second review a minute later."],
    ];
    for (const [json, message, next] of cases) {
      const r = await run(["artifact", "review", "pt_abc"], json, never, () => never());
      assert.equal(r.stderr, `Error: ${message}\nCode: INVALID_ARG\nNext action: ${next}\n`, json);
      assert.deepEqual(r.requests, [], `${json}: nothing sent`);
    }
    // The review's own checks come before any upload too: a blank comment elsewhere refuses it, nothing uploaded.
    const blank = await run(["artifact", "review", "pt_abc"], JSON.stringify({ comments: [{ body: "", images: ["./a.png"] }, { body: " " }] }), never, () => never());
    assert.ok(blank.stderr.startsWith("Error: Comment 2 of 2 (the whole artifact): The comment is empty. Nothing of the review was posted.\n"), blank.stderr);
    assert.deepEqual(blank.requests, []);
    const malformed = await run(["artifact", "review", "pt_abc"], review3("./a.png"), never);
    assert.ok(malformed.stderr.startsWith(`Error: Comment 3 of 3: "images" must be an array of image files' paths, like ["./before.png"]. Nothing was posted.\n`), malformed.stderr);
    // Without images a missing body is still refused.
    const noBody = await run(["artifact", "review", "pt_abc"], JSON.stringify({ comments: [{ path: "a.html", images: [] }] }), never);
    assert.ok(noBody.stderr.startsWith(`Error: Comment 1 of 1 has no "body". Nothing was posted.\n`), noBody.stderr);
    assert.deepEqual([...malformed.requests, ...noBody.requests], []);
  });
});

test("review with images on a Server from before images: the first upload's 404 without an Artifacts code posts nothing, under its own code", async () => {
  await inImageDir(async () => {
    const r = await run(["artifact", "review", "pt_abc"], JSON.stringify({ comments: [{ body: "a" }, { body: "look", images: ["./a.png", "./b.jpg"] }] }), never, () => ({ ok: false, status: 404, data: null, error: "Not found", errorCode: null, errorBody: { error: "Not found" } }) as unknown as ApiResponse<unknown>);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`], "the review is never posted without its images");
    assert.equal(r.stderr, [
      "Error: This Server can't take images in comments yet; nothing was posted.",
      "Code: UNSUPPORTED_BY_SERVER",
      "Next action: Post the review without images, or describe the images in words.",
      "",
    ].join("\n"));
  });
});

test("review with images: the Server refusing one image names its comment and file (the one uploaded before it left behind), a rate limit says nothing was posted; the review is not posted", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ body: "a", images: ["./a.png"] }, { path: "docs/a.html", body: "b", images: ["./b.jpg"] }] });
    const answers: UploadReply = (index) => (index === 0
      ? { ok: true, status: 201, data: kept("f-1", "image/png"), error: null }
      : { ok: false, status: 413, data: null, error: "image not kept", errorCode: "IMAGE_REFUSED", errorBody: { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "too_large", limit: 10 * 1024 * 1024 } } }) as unknown as ApiResponse<unknown>;
    const r = await run(["artifact", "review", "pt_abc"], json, never, answers);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`, `POST ${BASE}/pt_abc/comment-images`]);
    assert.equal(r.stderr, [
      "Error: Comment 2 of 2 (docs/a.html): image ./b.jpg: The image wasn't kept: it is larger than 10 MiB. Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour.",
      "Code: IMAGE_REFUSED",
      "Next action: Fix comment 2, then run the same command again. Send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.",
      "",
    ].join("\n"));
    const limited = { error: "This agent made too many image uploads: the limit is 30 a minute. Retry in 12 seconds.", code: "RATE_LIMITED", details: { operation: "artifactCommentImageUpload", limit: 30, windowSeconds: 60, retryAfterSeconds: 12 } };
    const busy = await run(["artifact", "review", "pt_abc"], json, never, () => ({ ok: false, status: 429, data: null, error: limited.error, errorCode: "RATE_LIMITED", errorBody: limited }) as unknown as ApiResponse<unknown>);
    assert.equal(busy.requests.length, 1);
    assert.ok(busy.stderr.includes("Next action: Nothing of the review was posted. Wait 12 seconds, then run the same command again:\nraft artifact review pt_abc <<'REVIEW'\n<the same review>\nREVIEW\n"), busy.stderr);
    // Cut short on the way: the comment and the image named, an image's words, the same command again.
    const cut = await run(["artifact", "review", "pt_abc"], json, never, () => ({ ok: false, status: 400, data: null, error: "x", errorCode: "SIZE_MISMATCH", errorBody: { error: "x", code: "SIZE_MISMATCH", details: { path: null, size: 12, actual: 8 } } }) as unknown as ApiResponse<unknown>);
    assert.equal(cut.stderr, [
      "Error: Comment 1 of 2 (the whole artifact): image ./a.png: The image didn't arrive whole (12 bytes sent, 8 received). Nothing of the review was posted.",
      "Code: SIZE_MISMATCH",
      "Next action: Run the same command again; if it's refused again, tell a human (it's a client bug).",
      "",
    ].join("\n"));
  });
});

/** A fresh id for each upload, so an image uploaded twice can't pass for the same one. */
const freshIds: UploadReply = (index) => ({ ok: true, status: 201, data: kept(`f-${index + 1}`, "image/png"), error: null }) as ApiResponse<unknown>;
const lost = () => ({ ok: false, status: 502, data: null, error: "bad gateway", errorCode: null, errorBody: null }) as unknown as ApiResponse<unknown>;
const UPLOAD = `POST ${BASE}/pt_abc/comment-images`;
const REVIEW = `POST ${BASE}/pt_abc/reviews`;

test("review with images: a lost answer is sent once more with the same image ids under the same key; the images are uploaded once", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ path: "components.html", body: "before and after", images: ["./a.png", "./b.jpg"] }, { replyTo: "c_812", images: ["./a.png"] }] });
    let posts = 0;
    const r = await run(["artifact", "review", "pt_abc"], json, () => {
      posts += 1;
      if (posts === 1) return lost();
      return ok({
        artifact: artifactRef, review: { ...review, body: null },
        comments: [{ ...comment("c_901", "components.html", "before and after"), images: [kept("f-1", "image/png"), kept("f-2", "image/png")] }, { ...comment("c_902", "components.html", "", "c_812"), images: [kept("f-3", "image/png")] }],
        notified: [], notNotified: [], newlySubscribed: false,
      }, 200);
    }, freshIds);
    assert.equal(r.error, null, r.stderr);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD, UPLOAD, REVIEW, REVIEW], "one set of uploads, two posts");
    const [first, second] = r.requests.filter((q) => q.body !== undefined).map((q) => keyed(q.body));
    assert.deepEqual(first!.body, { comments: [{ body: "before and after", path: "components.html", images: ["f-1", "f-2"] }, { body: "", replyTo: "c_812", images: ["f-3"] }] });
    assert.match(String(first!.key), UUID);
    assert.deepEqual(second, first, "the resend carries the same images and the same key");
    assert.ok(r.stdout.startsWith("Already posted: "), r.stdout);
  });
});

test("review with images: a failure after an image was uploaded says those go unused (a rate limit in its wait, a refusal in its message); before any, as it was", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ body: "a", images: ["./a.png"] }, { replyTo: "c_812", body: "b", images: ["./b.jpg"] }] });
    const again = "raft artifact review pt_abc <<'REVIEW'\n<the same review>\nREVIEW\n";
    // Rate limited at the second upload: the first is left behind.
    const limited = { error: "This agent made too many image uploads: the limit is 30 a minute. Retry in 12 seconds.", code: "RATE_LIMITED", details: { operation: "artifactCommentImageUpload", limit: 30, windowSeconds: 60, retryAfterSeconds: 12 } };
    const midway = await run(["artifact", "review", "pt_abc"], json, never, (index) => (index === 0
      ? freshIds(index)
      : { ok: false, status: 429, data: null, error: limited.error, errorCode: "RATE_LIMITED", errorBody: limited }) as unknown as ApiResponse<unknown>);
    assert.deepEqual(midway.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD]);
    assert.equal(midway.stderr, [
      `Error: ${limited.error}`,
      "Code: RATE_LIMITED",
      "Retryable: yes",
      `Next action: Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour. Wait 12 seconds, then run the same command again:\n${again}`,
    ].join("\n"));

    // The connection failing at the second upload: nothing posted, the first left behind, the same command again.
    const dropped = await run(["artifact", "review", "pt_abc"], json, never, (index) => {
      if (index === 0) return freshIds(index);
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(dropped.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD]);
    assert.equal(dropped.stderr, [
      "Error: The request did not reach the Raft Server. Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour.",
      "Code: ARTIFACT_FAILED",
      "Retryable: yes",
      `Next action: Check the connection to the Raft Server, then run the same command again:\n${again}`,
    ].join("\n"));

    // Every image uploaded, then the Server refuses the review: a comment of it, another --rev, or a hold.
    const notFound = await run(["artifact", "review", "pt_abc"], json, () => refusal(404, "COMMENT_NOT_FOUND", { index: 1, path: null, replyTo: "c_812" }), freshIds);
    assert.deepEqual(notFound.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD, REVIEW]);
    assert.ok(notFound.stderr.startsWith(`Error: Comment 2 of 2 (the reply to c_812): "c_812" isn't a comment of "pt_abc". Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour.\nCode: COMMENT_NOT_FOUND\nNext action: Fix comment 2, then run the same command again. `), notFound.stderr);
    const noVersion = await run(["artifact", "review", "pt_abc", "--rev", "99"], json, () => refusal(404, "VERSION_NOT_FOUND", { version: 99, currentVersion: 12 }), freshIds);
    assert.ok(noVersion.stderr.startsWith(`Error: "pt_abc" has no version 99 that you can read (the current one is v12). The images already uploaded go unused, and are gone within the hour.\nCode: VERSION_NOT_FOUND\n`), noVersion.stderr);
    // A hold's message lists what held it: the sentence follows the list, on a line of its own; its own sentences stay as written.
    const held = await run(["artifact", "review", "pt_abc"], json, () => refusal(409, "UNSEEN_CHANGES", { unseen: { commentCount: 1, comments: [], versionCount: 0, versions: [] } }), freshIds);
    assert.ok(held.stderr.startsWith("Error: Held — nothing of the review was posted. Since you last looked, others added to what it comments on (1 comment):\n"), held.stderr);
    assert.ok(held.stderr.includes("\nThe images already uploaded go unused, and are gone within the hour.\nCode: UNSEEN_CHANGES\n"), held.stderr);

    // No image uploaded yet: as it was.
    const first = await run(["artifact", "review", "pt_abc"], json, never, () => ({ ok: false, status: 429, data: null, error: limited.error, errorCode: "RATE_LIMITED", errorBody: limited }) as unknown as ApiResponse<unknown>);
    assert.ok(first.stderr.includes(`Next action: Nothing of the review was posted. Wait 12 seconds, then run the same command again:\n${again}`), first.stderr);
    const plain = await run(["artifact", "review", "pt_abc"], REVIEW_JSON, () => refusal(404, "COMMENT_NOT_FOUND", { index: 1, path: null, replyTo: "c_812" }));
    assert.ok(plain.stderr.startsWith(`Error: Comment 2 of 3 (the reply to c_812): "c_812" isn't a comment of "pt_abc". Nothing of the review was posted.\n`), plain.stderr);
  });
});

test("review with images: the server's quota or storage refusing an upload is the whole review's, not a comment's", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ path: "docs/a.html", body: "a", images: ["./a.png"] }] });
    const billingUrl = "https://app.raft.build/s/team/settings/billing";
    const quota = { error: "Monthly file upload quota exceeded.", code: "FILE_UPLOAD_QUOTA_EXCEEDED", billingUrl, details: { requestedBytes: 12, quota: { plan: "free", limitBytes: 100 * 1024 * 1024, usedBytes: 100 * 1024 * 1024 }, billingUrl } };
    const full = await run(["artifact", "review", "pt_abc"], json, never, () => ({ ok: false, status: 403, data: null, error: quota.error, errorCode: quota.code, errorBody: quota }) as unknown as ApiResponse<unknown>);
    assert.equal(full.stderr, [
      "Error: Not stored: this server's monthly file upload quota is used up (100 MiB of 100 MiB used this month). The Free plan includes 100 MB of uploads a month, and comment images count against it as attachments do. Nothing of the review was posted.",
      "Code: FILE_UPLOAD_QUOTA_EXCEEDED",
      `Next action: Say in the conversation that the image wasn't stored and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}. Until then, take "images" out of the JSON and run the same command again (describe the images in words instead).`,
      "",
    ].join("\n"));
    const storage = { error: "image storage is not configured", code: "ARTIFACTS_STORAGE_UNAVAILABLE" };
    const unset = await run(["artifact", "review", "pt_abc"], json, never, () => ({ ok: false, status: 503, data: null, error: storage.error, errorCode: storage.code, errorBody: storage }) as unknown as ApiResponse<unknown>);
    assert.equal(unset.stderr, [
      "Error: The image couldn't be stored: this server's file storage for Artifacts isn't set up. Nothing of the review was posted.",
      "Code: ARTIFACTS_STORAGE_UNAVAILABLE",
      `Next action: Take "images" out of the JSON and run the same command again (describe the images in words instead), and tell a human admin of this server.`,
      "",
    ].join("\n"));
    assert.deepEqual([...full.requests, ...unset.requests].map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD]);
  });
});

test("review with images: an image file that changes after the check, once one was uploaded, is refused naming its comment and file, and says the uploaded ones go unused", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ body: "a", images: ["./a.png"] }, { path: "docs/a.html", body: "b", images: ["./b.jpg"] }] });
    // While ./a.png uploads, ./b.jpg (a JPEG when checked) becomes an SVG.
    const r = await run(["artifact", "review", "pt_abc"], json, never, (index) => {
      writeFileSync("b.jpg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      return freshIds(index);
    });
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD], "the review is never posted");
    assert.equal(r.stderr, [
      "Error: Comment 2 of 2 (docs/a.html): image ./b.jpg is not a PNG, JPEG, WebP or GIF image (checked by its first bytes). Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour.",
      "Code: INVALID_ARG",
      "Next action: Fix comment 2, then run the same command again. Save it as a PNG, JPEG, WebP or GIF image (for an SVG or a PDF, a PNG screenshot of it).",
      "",
    ].join("\n"));
  });
});

test("review with images: a daemon proxy's failure mid-upload keeps its code and next step, and says nothing of the review was posted (and, once one was uploaded, that it goes unused)", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ body: "a", images: ["./a.png"] }, { path: "docs/a.html", body: "b", images: ["./b.jpg"] }] });
    const proxy = { layer: "local_daemon_proxy", correlationId: "eb15805d2c86f215", failureClass: "pre_response_transport", causeCode: "ECONNRESET", routeFamily: "agent-api/artifacts", responseStarted: false, responseComplete: false };
    // As the CLI's client throws it (throwProxyFailure): already the CLI's error.
    const proxyFailed = () => { throw apiFailureError({ status: 502, error: "upstream HTTP response failed", errorCode: "agent_proxy_failed", suggestedNextAction: null, proxy }, "CHECK_FAILED"); };
    const midway = await run(["artifact", "review", "pt_abc"], json, never, (index) => (index === 0 ? freshIds(index) : proxyFailed()));
    assert.deepEqual(midway.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, UPLOAD], "the review is never posted");
    assert.ok(midway.stderr.startsWith("Error: upstream HTTP response failed. Nothing of the review was posted. The images already uploaded go unused, and are gone within the hour.\nCode: PROXY_5XX\n"), midway.stderr);
    assert.ok(midway.stderr.includes("\nCorrelation: eb15805d2c86f215\n"), midway.stderr);
    assert.ok(midway.stderr.endsWith(`\nNext action: ${proxyFailureNextAction(proxy)}\n`), midway.stderr);
    // At the first upload: nothing was uploaded, so nothing is left behind.
    const first = await run(["artifact", "review", "pt_abc"], json, never, proxyFailed);
    assert.ok(first.stderr.startsWith("Error: upstream HTTP response failed. Nothing of the review was posted.\nCode: PROXY_5XX\n"), first.stderr);
  });
});

test("review with images: a lost answer, then a resend refused before the Server looks its key up (NOT_VISIBLE), says nothing of what was posted or left behind", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ comments: [{ body: "a", images: ["./a.png"] }] });
    let posts = 0;
    const r = await run(["artifact", "review", "pt_abc"], json, () => {
      posts += 1;
      return posts === 1 ? lost() : refusal(404, "NOT_VISIBLE", {});
    }, freshIds);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, REVIEW, REVIEW]);
    // The first may have gone in before the Artifact went out of sight: no "Nothing of the review was posted", no images left behind.
    assert.equal(r.stderr, [
      `Error: No artifact "pt_abc" that you can see (by that id, link or exact title).`,
      "Code: NOT_VISIBLE",
      "Next action: List the ones you can: raft artifact list",
      "",
    ].join("\n"));
  });
});

test("review with images: rerun under the key of a review that went in (IDEMPOTENCY_KEY_REUSED): nothing more posted, and no word of images going unused (that review has its own)", async () => {
  await inImageDir(async () => {
    const json = JSON.stringify({ idempotencyKey: "k-1", comments: [{ body: "a", images: ["./a.png"] }] });
    const r = await run(["artifact", "review", "pt_abc"], json, () => refusal(409, "IDEMPOTENCY_KEY_REUSED", {}), freshIds);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [UPLOAD, REVIEW], "sent once: a refusal, not a lost answer");
    assert.equal(r.stderr, [
      "Error: A review was already posted under that idempotencyKey, and this request differs from it (an edit, another --rev, or images uploaded again under new ids). Nothing more was posted.",
      "Code: IDEMPOTENCY_KEY_REUSED",
      `Next action: See the review that was posted among your comments: raft artifact comments pt_abc --all. Only to post a second review, take "idempotencyKey" out of the JSON and run the command again.`,
      "",
    ].join("\n"));
  });
});
