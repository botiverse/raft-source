// The export zip (streamingZip.ts) read back by the tools users have: the
// system `unzip` and Python's zipfile. Proves: UTF-8 names (Chinese, nested)
// and bytes come back exactly, an empty file and an empty archive are valid,
// an entry fed in many pieces is one file, a stream entry works, names are
// written once and in one piece, a failing sink or source fails the
// writer, and addBytes keeps to the sink's pace.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StreamingZipWriter, type ZipSink } from "./streamingZip";

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;
const hasPython = spawnSync("python3", ["--version"]).status === 0;

class MemorySink implements ZipSink {
  readonly chunks: Buffer[] = [];
  async write(chunk: Buffer): Promise<void> {
    this.chunks.push(Buffer.from(chunk));
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const AT = new Date("2026-11-18T10:15:30Z");
const LINES = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ id: `m${i}`, text: `消息 ${i} ${"x".repeat(i % 50)}` }) + "\n");

async function sampleArchive(): Promise<Buffer> {
  const sink = new MemorySink();
  const zip = new StreamingZipWriter(sink, AT);
  await zip.addBytes("manifest.json", Buffer.from(JSON.stringify({ format: 1 })));
  await zip.beginEntry("conversations/通用-c1/2026-11.jsonl");
  // Batches of lines, as a producer appends them.
  for (let i = 0; i < LINES.length; i += 250) await zip.write(Buffer.from(LINES.slice(i, i + 250).join(""), "utf8"));
  await zip.endEntry();
  await zip.addBytes("files/空文件.txt", Buffer.alloc(0));
  await zip.addStream("files/a1-photo.bin", Readable.from([Buffer.from([0, 1, 2, 255]), Buffer.from([7, 7])]));
  await zip.finish();
  assert.equal(zip.entryCount, 4);
  assert.equal(zip.bytesWritten, sink.bytes().length);
  return sink.bytes();
}

function withTempZip<T>(bytes: Buffer, use: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-zip-"));
  try {
    const file = path.join(dir, "export.zip");
    fs.writeFileSync(file, bytes);
    return use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED: Record<string, Buffer> = {
  "manifest.json": Buffer.from(JSON.stringify({ format: 1 })),
  "conversations/通用-c1/2026-11.jsonl": Buffer.from(LINES.join(""), "utf8"),
  "files/空文件.txt": Buffer.alloc(0),
  "files/a1-photo.bin": Buffer.from([0, 1, 2, 255, 7, 7]),
};

test.skipIf(!hasPython)("Python's zipfile reads every name and byte back, CRCs checked", async () => {
  const bytes = await sampleArchive();
  const listing = withTempZip(bytes, (file) => execFileSync("python3", ["-I", "-c", `
import base64, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    print(json.dumps({i.filename: [base64.b64encode(z.read(i)).decode(), bool(i.flag_bits & 0x800)] for i in z.infolist()}))
`, file], { encoding: "utf8" }));
  const read = JSON.parse(listing) as Record<string, [string, boolean]>;
  assert.deepEqual(Object.keys(read), Object.keys(EXPECTED));
  for (const [name, [b64, utf8Flag]] of Object.entries(read)) {
    assert.deepEqual(Buffer.from(b64, "base64"), EXPECTED[name], name);
    // ASCII-only names need no flag; every non-ASCII name carries it.
    if ([...name].some((c) => c.charCodeAt(0) > 0x7f)) assert.equal(utf8Flag, true, `${name}: UTF-8 flag`);
  }
});

test.skipIf(!hasUnzip)("the system unzip tests the archive and extracts the same files", async () => {
  const bytes = await sampleArchive();
  withTempZip(bytes, (file) => {
    const tested = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const out = path.join(path.dirname(file), "out");
    const extracted = spawnSync("unzip", ["-q", file, "-d", out], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr);
    for (const [name, expected] of Object.entries(EXPECTED)) {
      assert.deepEqual(fs.readFileSync(path.join(out, name)), expected, name);
    }
  });
});

test.skipIf(!hasPython)("an archive with no entries is valid", async () => {
  const sink = new MemorySink();
  const zip = new StreamingZipWriter(sink, AT);
  await zip.finish();
  const names = withTempZip(sink.bytes(), (file) => execFileSync("python3", ["-I", "-c",
    "import sys, zipfile; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))", file], { encoding: "utf8" }));
  assert.equal(names.trim(), "0");
});

test("a name is written once, entries do not overlap, and unsafe names are refused", async () => {
  const zip = new StreamingZipWriter(new MemorySink(), AT);
  await zip.addBytes("a.json", Buffer.from("{}"));
  await assert.rejects(zip.addBytes("a.json", Buffer.from("{}")), /already written/);
  await zip.beginEntry("b.jsonl");
  await assert.rejects(zip.beginEntry("c.jsonl"), /still open/);
  await assert.rejects(zip.addBytes("c.json", Buffer.from("{}")), /still open/);
  await assert.rejects(zip.finish(), /still open/);
  await zip.endEntry();
  for (const bad of ["", "/abs", "../up", "a/../b", "back\\slash"]) {
    await assert.rejects(zip.addBytes(bad, Buffer.from("x")), /invalid zip entry name/, bad);
  }
  await zip.finish();
  await assert.rejects(zip.addBytes("late.json", Buffer.from("{}")), /already finished/);
});

test("a sink that fails fails the writer instead of finishing a partial archive", async () => {
  let writes = 0;
  const zip = new StreamingZipWriter({
    async write() {
      writes += 1;
      if (writes > 1) throw new Error("storage down");
    },
  }, AT);
  await zip.addBytes("a.bin", Buffer.alloc(64 * 1024, 1));
  await zip.addBytes("b.bin", Buffer.alloc(64 * 1024, 2));
  await assert.rejects(zip.finish(), /storage down/);
  await assert.rejects(zip.addBytes("c.bin", Buffer.from("x")), /storage down|already finished/);
});

test("a source that fails mid-entry fails the writer at once, and every later call", async () => {
  const zip = new StreamingZipWriter(new MemorySink(), AT);
  async function* broken(): AsyncGenerator<Buffer> {
    yield Buffer.from("first bytes");
    throw new Error("attachment read failed");
  }
  await assert.rejects(zip.addStream("files/broken.bin", broken()), /attachment read failed/);
  await assert.rejects(zip.addBytes("next.json", Buffer.from("{}")), /attachment read failed/);
  await assert.rejects(zip.finish(), /attachment read failed/);
});

test("addBytes waits for a slow sink instead of queueing the whole entry in memory", async () => {
  const sink = new MemorySink();
  const slow: ZipSink = {
    async write(chunk) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await sink.write(chunk);
    },
  };
  const zip = new StreamingZipWriter(slow, AT);
  const entry = randomBytes(8 * 1024 * 1024); // incompressible
  await zip.addBytes("big.bin", entry);
  // Returned only once the sink had taken nearly all of it (yazl and the
  // streams buffer a little; never the whole 8 MiB).
  assert.ok(zip.bytesWritten > entry.length - 2 * 1024 * 1024, `bytesWritten ${zip.bytesWritten}`);
  await zip.finish();
  assert.equal(zip.bytesWritten, sink.bytes().length);
});
