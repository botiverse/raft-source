import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { CONTEXT_VIEW_SOURCE_MAX_BYTES, readContextViewSource } from "./contextViewSource";
import { PI_REQUEST_LOG_MAX_BYTES, piRequestDigest, PiRequestLog, piRequestLogFile, sweepPiRequestLogs } from "./piRequestLog";

const FACTS = { sessionId: "session-1", provider: "anthropic", api: "anthropic-messages", model: "claude-x" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-request-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function records(sessionId = "session-1"): Record<string, any>[] {
  return readFileSync(path.join(dir, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function log(): PiRequestLog {
  return new PiRequestLog(() => dir, () => {}, () => Date.parse("2026-11-06T00:00:00Z"));
}

/** The request's body again, from the file alone. */
function rebuilt(all: Record<string, any>[], index: number): { body: Record<string, unknown>; hashes: string[] } {
  const requests = all.filter((record) => record.type === "request");
  const hashesOf = (request: Record<string, any>): string[] => {
    if (!request.base) return request.tail;
    const base = requests.find((candidate) => candidate.id === request.base)!;
    return [...hashesOf(base).slice(0, request.keep), ...request.tail];
  };
  const request = requests[index]!;
  const hashes = hashesOf(request);
  const shape = all.find((record) => record.type === "shape" && record.hash === request.shapeHash)!;
  const messages = hashes.map((hash) => all.find((record) => record.type === "blob" && record.hash === hash)!.message);
  const { config, ...params } = request.params;
  const body = { ...shape.shape, ...params, [shape.messagesKey]: messages };
  return { body: config ? { ...body, config: { ...shape.shape.config, ...config } } : body, hashes };
}

test("a request reads back as the body sent, and a later one writes only what is new", () => {
  const requestLog = log();
  const shape = { model: "claude-x", system: [{ type: "text", text: "You are" }], tools: [{ name: "Bash" }], max_tokens: 10 };
  const first = { ...shape, messages: [{ role: "user", content: "hi" }] };
  const second = { ...shape, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "more" }] };
  requestLog.record(first, FACTS);
  requestLog.record(second, FACTS);

  const all = records();
  assert.deepEqual(all.map((record) => record.type), ["shape", "blob", "request", "blob", "blob", "request"]);
  assert.deepEqual(rebuilt(all, 0).body, first);
  assert.deepEqual(rebuilt(all, 1).body, second);
  const request = all.at(-1)!;
  assert.equal(request.keep, 1);
  assert.equal(request.base, all[2]!.id);
  assert.equal(request.tail.length, 2);
  assert.equal(request.at, "2026-11-06T00:00:00.000Z");
  assert.equal(request.model, "claude-x");
  assert.equal(request.digest, piRequestDigest(request.shapeHash, JSON.stringify(request.params), rebuilt(all, 1).hashes));
});

test("a rewritten history shares only its unchanged prefix, and a repeated message is written once", () => {
  const requestLog = log();
  const a = { role: "user", content: "a" };
  const b = { role: "user", content: "b" };
  requestLog.record({ messages: [a, b, a] }, FACTS);
  requestLog.record({ messages: [{ role: "user", content: "summary" }, b] }, FACTS);
  const all = records();
  assert.equal(all.filter((record) => record.type === "blob").length, 3);
  assert.equal(all.at(-1)!.keep, 0);
  assert.equal(all.at(-1)!.base, null);
  assert.deepEqual(rebuilt(all, 1).body.messages, [{ role: "user", content: "summary" }, b]);
});

test("each provider's message key is split out, and params that change per request don't repeat the shape", () => {
  const requestLog = log();
  const system = [{ type: "text", text: "You are" }];
  const responses = { model: "gpt", instructions: "x".repeat(1000), max_output_tokens: 5, input: [{ role: "user", content: "r" }] };
  const google = (maxOutputTokens: number) => ({ model: "gemini", config: { maxOutputTokens, systemInstruction: "be", tools: [{}] }, contents: [{ role: "user", parts: [] }] });
  requestLog.record({ model: "c", max_tokens: 100, system, messages: [] }, FACTS);
  requestLog.record({ model: "c", max_tokens: 90, system, messages: [] }, FACTS);
  requestLog.record(responses, FACTS);
  requestLog.record(google(30), FACTS);
  requestLog.record(google(20), FACTS);
  const all = records();
  const shapes = all.filter((record) => record.type === "shape");
  assert.deepEqual(shapes.map((record) => record.messagesKey), ["messages", "input", "contents"]);
  assert.equal(shapes[1]!.shape.instructions.length, 1000, "a long string stays in the shape");
  assert.deepEqual(all.filter((record) => record.type === "request")[1]!.params, { model: "c", max_tokens: 90 });
  assert.deepEqual(rebuilt(all, 1).body, { model: "c", max_tokens: 90, system, messages: [] });
  assert.deepEqual(rebuilt(all, 2).body, responses);
  assert.deepEqual(rebuilt(all, 4).body, google(20));
});

test("a body with no known message list isn't recorded, and the gap is marked", () => {
  const skips: string[] = [];
  const requestLog = new PiRequestLog(() => dir, (reason) => skips.push(reason));
  requestLog.record({ messages: [{ role: "user", content: "1" }] }, FACTS);
  requestLog.record({ context: { messages: [{ role: "user", content: "big" }] } }, FACTS);
  requestLog.record({ messages: [{ role: "user", content: "1" }, { role: "user", content: "2" }] }, FACTS);
  assert.deepEqual(skips, ["unknown_body"]);
  const all = records();
  assert.deepEqual(all.map((record) => record.type), ["shape", "blob", "request", "gap", "blob", "request"]);
  assert.equal(all[3]!.reason, "unknown_body");
  assert.ok(!readFileSync(path.join(dir, "session-1.jsonl"), "utf8").includes("big"));
});

test("inline media is kept as a marker, in every provider's form", () => {
  const bytes = "A".repeat(4000);
  const requestLog = log();
  requestLog.record({
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes } }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes}` } }] },
      { role: "user", parts: [{ inlineData: { mimeType: "image/webp", data: bytes } }] },
      { role: "user", content: [{ image: { format: "png", source: { bytes: new Uint8Array(3000) } } }] },
      { role: "assistant", content: [{ reasoningContent: { redactedContent: new Uint8Array(3000) } }] },
    ],
  }, FACTS);
  const text = readFileSync(path.join(dir, "session-1.jsonl"), "utf8");
  assert.ok(!text.includes(bytes), "no media bytes on disk");
  assert.ok(text.length < 4000, "nor bytes as numbers");
  const blobs = records().filter((record) => record.type === "blob");
  assert.match(blobs[0]!.message.content[0].source.data, /^\[raft:media image\/png 3000 bytes sha256=[0-9a-f]{64}\]$/);
  assert.match(blobs[1]!.message.content[0].image_url.url, /^\[raft:media image\/jpeg 3000 bytes sha256=/);
  assert.match(blobs[2]!.message.parts[0].inlineData.data, /^\[raft:media image\/webp 3000 bytes/);
  assert.match(blobs[3]!.message.content[0].image.source.bytes, /^\[raft:media unknown 3000 bytes/);
});

test("masking leaves text alone, whatever it looks like", () => {
  const base64ish = "A".repeat(2000);
  const messages = [
    { role: "tool", content: `data:text/plain;base64,aGk=\nand then real tool output ${"word ".repeat(100)}` },
    { role: "assistant", content: [{ type: "tool_use", name: "write", input: { data: `${"a".repeat(300)} then prose` } }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: base64ish }, { type: "text", text: "base64" }] },
    { role: "user", content: "the word base64 in a sentence", data: "short" },
    { role: "tool", content: [{ type: "text", data: base64ish }, { type: "text", text: "base64" }] },
    { role: "tool", content: [{ type: "image", data: base64ish }] },
    { role: "tool", content: "data:text/plain;base64,aGk=" },
  ];
  log().record({ messages }, FACTS);
  assert.deepEqual(rebuilt(records(), 0).body.messages, messages);
});

test("off stops the writing at once; on again marks the gap, and starts over in the same file", () => {
  let on = true;
  const requestLog = new PiRequestLog(() => (on ? dir : null));
  requestLog.record({ messages: [{ role: "user", content: "1" }] }, FACTS);
  on = false;
  requestLog.record({ messages: [{ role: "user", content: "2" }] }, FACTS);
  assert.equal(records().filter((record) => record.type === "request").length, 1);
  on = true;
  requestLog.record({ messages: [{ role: "user", content: "3" }] }, FACTS);
  const all = records();
  assert.deepEqual(all.map((record) => record.type), ["shape", "blob", "request", "gap", "shape", "blob", "request"]);
  assert.equal(all[3]!.reason, "off");
  assert.deepEqual(rebuilt(all, 1).body.messages, [{ role: "user", content: "3" }]);
});

test("a new session gets its own file; a restart continues the old one and reads back", () => {
  const first = log();
  first.record({ model: "m", messages: [{ role: "user", content: "1" }] }, FACTS);
  first.record({ model: "m", messages: [{ role: "user", content: "x" }] }, { ...FACTS, sessionId: "session-2" });
  assert.equal(records("session-2").filter((record) => record.type === "request").length, 1);
  const restarted = log();
  restarted.record({ model: "m", messages: [{ role: "user", content: "1" }, { role: "user", content: "2" }] }, FACTS);
  const all = records();
  assert.equal(all.at(-1)!.base, null, "a restart doesn't refer to a request it hasn't read");
  assert.deepEqual(rebuilt(all, 1).body.messages, [{ role: "user", content: "1" }, { role: "user", content: "2" }]);
});

test("a line cut by a crash doesn't take the next record with it", () => {
  log().record({ model: "m", messages: [{ role: "user", content: "1" }] }, FACTS);
  const file = path.join(dir, "session-1.jsonl");
  appendFileSync(file, '{"type":"blob","hash":"cut');
  log().record({ model: "m", messages: [{ role: "user", content: "2" }] }, FACTS);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines[3], '{"type":"blob","hash":"cut');
  const all = lines.filter((_, index) => index !== 3).map((line) => JSON.parse(line));
  assert.deepEqual(rebuilt(all, 1).body.messages, [{ role: "user", content: "2" }]);
});

test("a file swept or cut under a live log starts over, so nothing refers to what's gone", () => {
  const requestLog = log();
  const one = { role: "user", content: "1" };
  requestLog.record({ model: "m", messages: [one] }, FACTS);
  const file = path.join(dir, "session-1.jsonl");
  unlinkSync(file);
  requestLog.record({ model: "m", messages: [one, { role: "user", content: "2" }] }, FACTS);
  const swept = records();
  assert.deepEqual(swept.map((record) => record.type), ["shape", "blob", "blob", "request"]);
  assert.equal(swept.at(-1)!.base, null);

  truncateSync(file, statSync(file).size - 5);
  requestLog.record({ model: "m", messages: [one, { role: "user", content: "3" }] }, FACTS);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const after = lines.slice(lines.findIndex((line) => line.startsWith('{"type":"request"') || !line.endsWith("}")) + 1).map((line) => JSON.parse(line));
  assert.deepEqual(rebuilt(after, 0).body.messages, [one, { role: "user", content: "3" }]);
});

test("nothing here can fail the call: bad input and bad disks are reported, not thrown", () => {
  const skips: string[] = [];
  const requestLog = new PiRequestLog(() => dir, (reason) => skips.push(reason));
  requestLog.record("a string", FACTS);
  requestLog.record(null, FACTS);
  requestLog.record({ messages: [] }, { ...FACTS, sessionId: "../escape" });
  const circular: Record<string, unknown> = { messages: [] };
  circular.self = circular;
  requestLog.record(circular, FACTS);
  assert.deepEqual(skips, ["not_an_object", "bad_session_id", "write_failed"]);
  assert.equal(existsSync(path.join(path.dirname(dir), "escape.jsonl")), false);

  const blocked = path.join(dir, "blocked");
  writeFileSync(blocked, "a file where the directory should be");
  const noDir: string[] = [];
  new PiRequestLog(() => blocked, (reason) => noDir.push(reason)).record({ messages: [] }, FACTS);
  assert.deepEqual(noDir, ["write_failed"]);
});

test("the file stops at the cap, marks it once, and stays readable by the restore", async () => {
  const skips: string[] = [];
  const file = piRequestLogFile(dir, "session-1")!;
  const requestLog = new PiRequestLog(() => dir, (reason) => skips.push(reason));
  writeFileSync(file, "");
  truncateSync(file, PI_REQUEST_LOG_MAX_BYTES - 100);
  requestLog.record({ messages: [{ role: "user", content: "too much" }] }, FACTS);
  requestLog.record({ messages: [{ role: "user", content: "still too much" }] }, FACTS);
  assert.deepEqual(skips, ["over_cap"]);
  const tail = readFileSync(file).subarray(PI_REQUEST_LOG_MAX_BYTES - 100).toString("utf8");
  assert.deepEqual(tail.trim().split("\n").map((line) => JSON.parse(line).type), ["gap"], "after the cut line, on its own line");

  // A restart that still can't fit changes nothing once there's no room for the mark.
  truncateSync(file, PI_REQUEST_LOG_MAX_BYTES - 10);
  log().record({ messages: [{ role: "user", content: "after a restart" }] }, FACTS);
  assert.equal(statSync(file).size, PI_REQUEST_LOG_MAX_BYTES - 10);
  assert.ok(PI_REQUEST_LOG_MAX_BYTES <= CONTEXT_VIEW_SOURCE_MAX_BYTES);
  assert.equal((await readContextViewSource(file, [dir])).ok, true);
});

test("something planted at the file's path can't hang the daemon or take the write", () => {
  const skips: string[] = [];
  execFileSync("mkfifo", [path.join(dir, "session-1.jsonl")]);
  new PiRequestLog(() => dir, (reason) => skips.push(reason)).record({ messages: [] }, FACTS);
  const outside = path.join(dir, "outside");
  writeFileSync(outside, "");
  symlinkSync(outside, path.join(dir, "session-2.jsonl"));
  new PiRequestLog(() => dir, (reason) => skips.push(reason)).record({ messages: [] }, { ...FACTS, sessionId: "session-2" });
  assert.deepEqual(skips, ["write_failed", "write_failed"]);
  assert.equal(readFileSync(outside, "utf8"), "");
});

test("files are private", () => {
  log().record({ messages: [] }, FACTS);
  assert.equal(statSync(path.join(dir, "session-1.jsonl")).mode & 0o777, 0o600);
});

test("the sweep removes only old session logs", () => {
  mkdirSync(path.join(dir, "keep"));
  writeFileSync(path.join(dir, "old.jsonl"), "x");
  writeFileSync(path.join(dir, "new.jsonl"), "x");
  writeFileSync(path.join(dir, "old.txt"), "x");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(dir, "old.jsonl"), old, old);
  utimesSync(path.join(dir, "old.txt"), old, old);
  assert.equal(sweepPiRequestLogs(dir, Date.now() - 30 * 24 * 60 * 60 * 1000), 1);
  assert.deepEqual(["old.jsonl", "new.jsonl", "old.txt"].map((name) => existsSync(path.join(dir, name))), [false, true, true]);
  assert.equal(sweepPiRequestLogs(path.join(dir, "missing"), Date.now()), 0);
});
