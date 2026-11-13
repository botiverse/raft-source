// The STORE-only zip writer of the public download (storedZip.ts), read back
// by a test-only reader that follows the format as unzip does (the end
// record, the central directory, then each local header) and checks every
// CRC-32 with node:zlib. Proves: names (nested, UTF-8) and bytes come back
// exactly, the length is storedZipSize's, an empty archive is valid, and a
// file whose bytes don't match its size fails the stream.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readStoredZip as readZip } from "../../test/storedZipReader";
import { storedZip, storedZipSize, type StoredZipEntry } from "./storedZip";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

const entry = (name: string, bytes: Buffer): StoredZipEntry => ({ name, size: bytes.length, read: async () => bytes });

test("names and bytes come back exactly, in order, at the size computed beforehand", async () => {
  const files = [
    entry("index.html", Buffer.from("<h1>Hi</h1>")),
    entry("assets/img/logo (1).png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 7])),
    entry("docs/résumé 日本.md", Buffer.from("# ünïcode\n")),
    entry("empty.txt", Buffer.alloc(0)),
  ];
  const zip = await collect(storedZip(files, new Date("2026-10-29T08:15:30Z")));
  assert.equal(zip.length, storedZipSize(files));
  const read = readZip(zip);
  assert.deepEqual(read.map((file) => file.name), files.map((file) => file.name));
  for (const [i, file] of read.entries()) assert.deepEqual(file.bytes, await files[i]!.read(), file.name);
  assert.deepEqual(read[1]!.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]));
  assert.equal(read[2]!.bytes.toString("utf8"), "# ünïcode\n");
  assert.equal(read[3]!.bytes.length, 0);
});

test("an empty archive is the end record alone", async () => {
  const zip = await collect(storedZip([], new Date()));
  assert.equal(zip.length, 22);
  assert.deepEqual(readZip(zip), []);
});

test("a file whose bytes aren't its size fails the stream", async () => {
  const wrong: StoredZipEntry = { name: "a.txt", size: 10, read: async () => Buffer.from("short") };
  await assert.rejects(collect(storedZip([wrong], new Date())), /a\.txt is 5 bytes, not 10/);
});

test("destroy closes a ZIP whose file read never returns, aborts the read and starts no next file", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  let readSignal: AbortSignal | undefined;
  let nextReads = 0;
  const stream = storedZip([
    { name: "first", size: 1, read: async (signal) => { readSignal = signal; reached(); await gate; return Buffer.from("a"); } },
    { name: "next", size: 1, read: async () => { nextReads += 1; return Buffer.from("b"); } },
  ], new Date());
  const closed = once(stream, "close");
  stream.resume();
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    stream.destroy();
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise<"still open">((resolve) => { timer = setTimeout(() => resolve("still open"), 500); }),
    ]);
    assert.equal(outcome, "closed", "destroy cannot depend on the storage read finishing");
    assert.equal(readSignal?.aborted, true, "cancellation reaches the entry reader");
    assert.equal(nextReads, 0);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    stream.destroy();
    await closed;
  }
});
