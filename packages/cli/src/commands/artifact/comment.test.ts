// `raft artifact comment` / `follow` / `unfollow` through the real
// parser: the comment comes from stdin as written, every flag reaches the
// request, an empty stdin is refused before any request, and the answer is the
// shared text.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

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
const artifactRef = { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 };

/** An image upload's answer (the raw-body route), by its place among the uploads (0-based). */
type UploadReply = (index: number) => ApiResponse<unknown>;

async function run(argv: string[], stdin: string | null, reply: (method: string, path: string, body?: unknown) => unknown, upload?: UploadReply) {
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
        return { ok: true, status: 200, data: reply(method, path, body) as T, error: null };
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

test("comment: the body from stdin as written, --path, --reply-to and --rev reach the request; the answer is the shared text", async () => {
  const body = 'Keep the "old" header,\n@Kirby — and `this` too.\n';
  const r = await run(["artifact", "comment", "pt_abc", "--path", "a b.html", "--reply-to", "c_1", "--rev", "v12"], body, () => ({
    artifact: artifactRef,
    comment: { id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: "a b.html", anchor: null, replyTo: "c_1", body, createdAt: "2026-10-22T00:00:00.000Z", editedAt: null },
    notified: [{ actor: { type: "agent", name: "Kirby" }, reason: "mentioned" }],
    notNotified: [],
    newlySubscribed: false,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(r.requests, [{ method: "POST", path: `${BASE}/pt_abc/comments`, body: { body: body.trim(), path: "a b.html", replyTo: "c_1", version: 12 } }]);
  assert.ok(r.stdout.startsWith(`Replied to c_1 on a b.html (v12) of "Proto" (pt_abc): c_9.\nNotified: @Kirby (mentioned).`), r.stdout);
});

test("comment: nothing on stdin is refused before any request, with the heredoc to use", async () => {
  const tty = await run(["artifact", "comment", "pt_abc", "--path", "a.html", "--reply-to", "c_1"], null, () => { throw new Error("no request expected"); });
  assert.ok(tty.stderr.includes("No comment received on stdin.") && tty.stderr.includes(`raft artifact comment pt_abc --path 'a.html' --reply-to c_1 <<'COMMENT'`), tty.stderr);
  const quoted = await run(["artifact", "comment", "pt_abc", "--path", "it's $HOME.md"], null, () => { throw new Error("no request expected"); });
  assert.ok(quoted.stderr.includes(`raft artifact comment pt_abc --path 'it'\\''s $HOME.md' <<'COMMENT'`), quoted.stderr);
  const blank = await run(["artifact", "comment", "pt_abc"], "  \n", () => { throw new Error("no request expected"); });
  assert.ok(blank.stderr.includes("No comment received on stdin."), blank.stderr);
  assert.equal(tty.requests.length + blank.requests.length, 0);
});

test("follow and unfollow: PUT and DELETE, then where you stand and how to undo it", async () => {
  const on = await run(["artifact", "follow", "pt_abc"], null, () => ({ artifact: artifactRef, following: true }));
  const off = await run(["artifact", "unfollow", "--artifact", "pt_abc"], null, () => ({ artifact: artifactRef, following: false }));
  assert.deepEqual([...on.requests, ...off.requests].map((q) => `${q.method} ${q.path}`), [`PUT ${BASE}/pt_abc/subscription`, `DELETE ${BASE}/pt_abc/subscription`]);
  assert.ok(on.stdout.endsWith("To stop: raft artifact unfollow pt_abc\n"), on.stdout);
  assert.ok(off.stdout.endsWith("To follow it again: raft artifact follow pt_abc\n"), off.stdout);
});

test("comment: a link through --artifact, an extra argument refused, a hold shown with its code", async () => {
  const extra = await run(["artifact", "comment", "pt_abc", "LGTM"], "body", () => { throw new Error("no request expected"); });
  assert.ok(extra.stderr.includes("Unexpected argument: LGTM") && extra.stderr.includes("The comment goes on stdin"), extra.stderr);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: string[] = [];
  const program = buildRaftProgram({
    io: {
      stdout: { write: (c: string | Uint8Array) => { stdout.push(String(c)); return true; } },
      stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } },
      stdin: Readable.from(["ok"]),
    },
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string): Promise<ApiResponse<T>> => {
        requests.push(`${method} ${path}`);
        const errorBody = { error: "held", code: "UNSEEN_CHANGES", details: { unseen: { comments: [], commentCount: 0, commentsCursor: null, versions: [{ number: 13, publisher: { type: "agent", name: "Tenny" }, createdAt: "2026-10-22T00:00:00.000Z", note: null, changedPaths: ["a.html"] }], versionCount: 1 }, seen: 3 } };
        return { ok: false, status: 409, data: null, error: "held", errorCode: "UNSEEN_CHANGES", errorBody };
      },
    }) as any,
  });
  await program.parseAsync(["artifact", "comment", "--artifact", "https://app.raft.build/artifacts/pt_abc", "--path", "a.html"], { from: "user" }).catch(() => undefined);
  assert.deepEqual(requests, [`POST ${BASE}/pt_abc/comments`]);
  const err = stderr.join("");
  assert.ok(err.includes("Held — not posted.") && err.includes("- v13 by @Tenny: a.html") && err.includes("Code: UNSEEN_CHANGES") && err.includes("run the same command again"), err);
});

test("comment: over core's rate limit, the Server's sentence, when to retry, and the same command to run again with the comment on stdin; never retried", async () => {
  const stderr: string[] = [];
  const requests: string[] = [];
  const errorBody = { error: "This agent made too many artifact changes: the limit is 60 a minute. Retry in 23 seconds.", code: "RATE_LIMITED", details: { operation: "artifactComment", limit: 60, windowSeconds: 60, retryAfterSeconds: 23 } };
  const program = buildRaftProgram({
    io: {
      stdout: { write: () => true },
      stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } },
      stdin: Readable.from(["Keep the header"]),
    },
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string): Promise<ApiResponse<T>> => {
        requests.push(`${method} ${path}`);
        return { ok: false, status: 429, data: null, error: errorBody.error, errorCode: "RATE_LIMITED", errorBody };
      },
    }) as any,
  });
  await program.parseAsync(["--profile", "ops", "artifact", "comment", "pt_abc", "--path", "it's a.html", "--reply-to", "c_1"], { from: "user" }).catch(() => undefined);
  assert.deepEqual(requests, [`POST ${BASE}/pt_abc/comments`], "sent once, not retried");
  assert.equal(stderr.join(""), [
    "Error: This agent made too many artifact changes: the limit is 60 a minute. Retry in 23 seconds.",
    "Code: RATE_LIMITED",
    "Retryable: yes",
    "Next action: Wait 23 seconds, then run the same command again (the refused request changed nothing):",
    "raft --profile ops artifact comment pt_abc --path 'it'\\''s a.html' --reply-to c_1 <<'COMMENT'",
    "<the same comment>",
    "COMMENT",
    "",
  ].join("\n"));
});

// ── images (#146): --image files checked before anything is sent, uploaded in order, then the comment ──

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const kept = (fileId: string, contentType: string, sizeBytes: number, width: number, height: number) => ({ fileId, contentType, sizeBytes, width, height });
const uploaded = (...images: Array<ReturnType<typeof kept>>): UploadReply => (index) => ({ ok: true, status: 201, data: images[index], error: null });
const commented = (body: string, images: unknown[]) => ({
  artifact: artifactRef,
  comment: { id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: null, anchor: null, replyTo: null, body, createdAt: "2026-10-22T00:00:00.000Z", editedAt: null, images },
  notified: [],
  notNotified: [],
  newlySubscribed: false,
});

/** Run with the images in a fresh temp directory as the current directory, so `./a.png` is the path the agent typed. */
async function inImageDir<T>(body: () => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "raft-artifact-comment-images-")));
  const before = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync("a.png", new Uint8Array(PNG));
    writeFileSync("b.jpg", new Uint8Array(JPEG));
    writeFileSync("x.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    writeFileSync("big.png", new Uint8Array(PNG));
    // 12.4 MiB, sparse: its size is decided before anything is read.
    truncateSync("big.png", 13_002_342);
    return await body();
  } finally {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  }
}

const noRequest = () => { throw new Error("no request expected"); };

test("comment --image: each file uploaded in order as raw bytes, then the comment with their ids; the receipt lists them with how to save each", async () => {
  await inImageDir(async () => {
    const images = [kept("f-1", "image/png", 319_488, 1280, 800), kept("f-2", "image/jpeg", 2_202_009, 4032, 3024)];
    const r = await run(["artifact", "comment", "pt_abc", "--image", "./a.png", "--image", "./b.jpg"], "before and after\n", () => commented("before and after", images), uploaded(...images));
    assert.equal(r.error, null, r.stderr);
    assert.deepEqual(r.requests, [
      { method: "POST", path: `${BASE}/pt_abc/comment-images`, bytes: PNG.slice(0, 4) },
      { method: "POST", path: `${BASE}/pt_abc/comment-images`, bytes: JPEG.slice(0, 4) },
      { method: "POST", path: `${BASE}/pt_abc/comments`, body: { body: "before and after", images: ["f-1", "f-2"] } },
    ]);
    assert.equal(r.stdout, [
      `Commented on the whole artifact (v12) of "Proto" (pt_abc): c_9.`,
      "  Images (2):",
      "    1. PNG 1280x800, 312 KiB: raft artifact download pt_abc --image f-1 --output comment-c_9-1.png",
      "    2. JPEG 4032x3024, 2.1 MiB: raft artifact download pt_abc --image f-2 --output comment-c_9-2.jpg",
      "No one was notified. To bring someone in, @name them in a reply: raft artifact comment pt_abc --reply-to c_9",
      "",
    ].join("\n"));
  });
});

test("comment --image: with an image the text may be empty (nothing piped, or an empty stdin); without one, still refused", async () => {
  await inImageDir(async () => {
    const image = kept("f-1", "image/png", 12, 1, 1);
    for (const stdin of [null, "", "  \n"]) {
      const r = await run(["artifact", "comment", "pt_abc", "--image", "./a.png"], stdin, () => commented("", [image]), uploaded(image));
      assert.equal(r.error, null, r.stderr);
      assert.deepEqual(r.requests.at(-1), { method: "POST", path: `${BASE}/pt_abc/comments`, body: { body: "", images: ["f-1"] } });
      assert.ok(r.stdout.includes("\n  Images (1):\n    1. PNG 1x1, 12 bytes: raft artifact download pt_abc --image f-1 --output comment-c_9-1.png\n"), r.stdout);
    }
  });
});

test("comment --image: refused before any request: more than 4, unreadable, over 10 MiB, not an image (by its first bytes)", async () => {
  await inImageDir(async () => {
    const cases: Array<[string[], string, string]> = [
      [["--image", "./a.png", "--image", "./a.png", "--image", "./a.png", "--image", "./a.png", "--image", "./b.jpg"], "A comment takes at most 4 images (5 given). Nothing was sent.", "Keep 4 in this comment and post the others in a reply to it."],
      [["--image", "./a.png", "--image", "./missing.png"], "--image ./missing.png can't be read (no such file). Nothing was sent.", "Check the path (relative to the directory you run the command in), then run the same command again."],
      [["--image", "./big.png"], "--image ./big.png is 12.4 MiB; an image can be at most 10 MiB. Nothing was sent.", "Make it smaller (fewer pixels, or JPEG or WebP for a photo), then run the same command again."],
      [["--image", "./x.svg"], "--image ./x.svg is not a PNG, JPEG, WebP or GIF image (checked by its first bytes). Nothing was sent.", "Save it as a PNG, JPEG, WebP or GIF image (for an SVG or a PDF, a PNG screenshot of it), then run the same command again."],
      [["--image", "."], "--image . can't be read (it is a directory). Nothing was sent.", "Check the path (relative to the directory you run the command in), then run the same command again."],
    ];
    for (const [flags, message, next] of cases) {
      const r = await run(["artifact", "comment", "pt_abc", ...flags], "look", noRequest, noRequest);
      assert.equal(r.stderr, `Error: ${message}\nCode: INVALID_ARG\nNext action: ${next}\n`, flags.join(" "));
      assert.deepEqual(r.requests, [], `${flags.join(" ")}: nothing sent`);
    }
  });
});

test("comment --image on a Server from before images: the upload's 404 without an Artifacts code posts nothing, under its own code", async () => {
  await inImageDir(async () => {
    const r = await run(["artifact", "comment", "pt_abc", "--image", "./a.png"], "look", noRequest, () => ({ ok: false, status: 404, data: null, error: "Not found", errorCode: null, errorBody: { error: "Not found" } }));
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`], "the comment is never posted without its images");
    assert.equal(r.stderr, [
      "Error: This Server can't take images in comments yet; nothing was posted.",
      "Code: UNSUPPORTED_BY_SERVER",
      "Next action: Post the comment without --image, or describe the image in words.",
      "",
    ].join("\n"));
    // A 404 with the Artifacts' code is the Artifact's, in its own words.
    const hidden = await run(["artifact", "comment", "pt_abc", "--image", "./a.png"], "look", noRequest, () => ({ ok: false, status: 404, data: null, error: "artifact not visible", errorCode: "NOT_VISIBLE", errorBody: { error: "artifact not visible", code: "NOT_VISIBLE" } }));
    assert.ok(hidden.stderr.startsWith(`Error: No artifact "pt_abc" that you can see (by that id, link or exact title).\nCode: NOT_VISIBLE\n`), hidden.stderr);
  });
});

test("comment --image: the Server refusing one image names which --image it was; nothing is posted", async () => {
  await inImageDir(async () => {
    const answers: UploadReply = (index) => (index === 0
      ? { ok: true, status: 201, data: kept("f-1", "image/png", 12, 1, 1), error: null }
      : { ok: false, status: 413, data: null, error: "image not kept", errorCode: "IMAGE_REFUSED", errorBody: { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "too_large", limit: 10 * 1024 * 1024 } } });
    const r = await run(["artifact", "comment", "pt_abc", "--image", "./a.png", "--image", "./b.jpg"], "look", noRequest, answers);
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`, `POST ${BASE}/pt_abc/comment-images`]);
    assert.equal(r.stderr, [
      "Error: --image ./b.jpg: The image wasn't kept: it is larger than 10 MiB. Nothing was posted.",
      "Code: IMAGE_REFUSED",
      "Next action: Send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.",
      "",
    ].join("\n"));
    // Cut short on the way: an image's words (not a push's sha256), the same command again.
    const cut = await run(["artifact", "comment", "pt_abc", "--image", "./a.png"], "look", noRequest, () => ({ ok: false, status: 400, data: null, error: "x", errorCode: "SIZE_MISMATCH", errorBody: { error: "x", code: "SIZE_MISMATCH", details: { path: null, size: 12, actual: 8 } } }));
    assert.equal(cut.stderr, [
      "Error: --image ./a.png: The image didn't arrive whole (12 bytes sent, 8 received). Nothing was posted.",
      "Code: SIZE_MISMATCH",
      "Next action: Run the same command again; if it's refused again, tell a human (it's a client bug).",
      "",
    ].join("\n"));
  });
});

test("comment --image: an upload that doesn't reach the Server posts nothing, and says so (and that images uploaded before it go unused); the next step is the same command again", async () => {
  await inImageDir(async () => {
    const r = await run(["artifact", "comment", "pt_abc", "--image", "./a.png"], "look", noRequest, () => { throw new TypeError("fetch failed"); });
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`], "the comment is never posted");
    assert.equal(r.stderr, [
      "Error: The request did not reach the Raft Server. Nothing was posted.",
      "Code: ARTIFACT_FAILED",
      "Retryable: yes",
      "Next action: Check the connection to the Raft Server, then run the same command again:",
      "raft artifact comment pt_abc --image ./a.png <<'COMMENT'",
      "<the same comment>",
      "COMMENT",
      "",
    ].join("\n"));
    const second = await run(["artifact", "comment", "pt_abc", "--image", "./a.png", "--image", "./b.jpg"], "look", noRequest, (index) => {
      if (index === 0) return { ok: true, status: 201, data: kept("f-1", "image/png", 12, 1, 1), error: null };
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(second.requests.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/pt_abc/comment-images`, `POST ${BASE}/pt_abc/comment-images`]);
    assert.ok(second.stderr.startsWith("Error: The request did not reach the Raft Server. Nothing was posted. The images already uploaded go unused, and are gone within the hour.\nCode: ARTIFACT_FAILED\n"), second.stderr);
  });
});
