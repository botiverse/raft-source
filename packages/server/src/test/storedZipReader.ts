// Test-only: reads a STORE-only zip (apps/artifacts/storedZip.ts) back as
// unzip does: the end record, the central directory, then each local header,
// every CRC-32 checked with node:zlib. Fails (assert) on anything else.
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";

/** Every entry of a zip, by the central directory, its CRC checked. */
export function readStoredZip(zip: Buffer): Array<{ name: string; bytes: Buffer }> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, "end of central directory");
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  assert.equal(at + directorySize, end, "the directory ends where the end record starts");
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "central header");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    assert.equal(zip.readUInt32LE(at + 24), size);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    assert.equal(method, 0, "stored");
    assert.equal(zip.readUInt32LE(local), 0x04034b50, "local header");
    assert.equal(zip.readUInt32LE(local + 14), crc, "the local header's CRC");
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    assert.equal(zip.subarray(local + 30, local + 30 + localName).toString("utf8"), name);
    const start = local + 30 + localName + localExtra;
    const bytes = zip.subarray(start, start + size);
    assert.equal(crc32(bytes), crc, `${name}: CRC`);
    out.push({ name, bytes: Buffer.from(bytes) });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

