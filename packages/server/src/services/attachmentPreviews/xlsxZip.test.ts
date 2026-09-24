import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import * as XLSX from "xlsx";
import { buildXlsxPreview } from "./providers/xlsx.js";

vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  return { ...actual, read: vi.fn(actual.read) };
});
const realRead = (await vi.importActual<typeof import("xlsx")>("xlsx")).read;

function workbook(compression = true): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Value"], ["safe"]]), "Data");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression });
}

function directory(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const start = zip.readUInt32LE(end + 16);
  const records: Array<{ central: number; local: number }> = [];
  let cursor = start;
  for (let i = 0; i < zip.readUInt16LE(end + 10); i += 1) {
    records.push({ central: cursor, local: zip.readUInt32LE(cursor + 42) });
    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return { end, start, records };
}

function insertBeforeDirectory(zip: Buffer, offset: number, data: Buffer): Buffer {
  const old = directory(zip);
  const next = Buffer.concat([zip.subarray(0, offset), data, zip.subarray(offset)]);
  for (const record of old.records) {
    if (record.local >= offset) next.writeUInt32LE(record.local + data.length, record.central + data.length + 42);
  }
  next.writeUInt32LE(old.start + data.length, old.end + data.length + 16);
  return next;
}

function assertRejectedBeforeSheetJS(zip: Buffer) {
  // Trap the decoder entry, so a regression cannot allocate the forged size.
  // The valid-file test below also proves that this spy observes the real path.
  const read = vi.mocked(XLSX.read).mockClear().mockImplementation(() => {
    throw new Error("untrusted ZIP reached SheetJS");
  });
  try {
    assert.equal(buildXlsxPreview(zip), null);
    assert.equal(read.mock.calls.length, 0, "invalid ZIP must be rejected before invoking SheetJS");
  } finally {
    read.mockReset().mockImplementation(realRead);
  }
}

afterEach(() => { vi.mocked(XLSX.read).mockReset().mockImplementation(realRead); });

for (const compression of [false, true]) {
  test(`valid ${compression ? "deflated" : "stored"} XLSX reaches SheetJS and previews cells`, () => {
    const zip = workbook(compression);
    const read = vi.mocked(XLSX.read);
    assert.deepEqual(buildXlsxPreview(zip)?.sheets[0].rows, [["safe"]]);
    assert.equal(read.mock.calls.length, 1);
  });
}

test("forged 128 MiB local size cannot bypass a small central-directory declaration", () => {
  const zip = workbook();
  const first = directory(zip).records[0];
  assert.ok(zip.length < 10 * 1024);
  assert.ok(zip.readUInt32LE(first.central + 24) < 16 * 1024 * 1024);
  zip.writeUInt32LE(128 * 1024 * 1024, first.local + 22);
  assertRejectedBeforeSheetJS(zip);
});

test("a local ZIP64 extra cannot override bounded 32-bit sizes", () => {
  const zip = workbook();
  const first = directory(zip).records[0];
  const extraLength = zip.readUInt16LE(first.local + 28);
  const extraEnd = first.local + 30 + zip.readUInt16LE(first.local + 26) + extraLength;
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(128n * 1024n * 1024n, 4);
  extra.writeBigUInt64LE(BigInt(zip.readUInt32LE(first.central + 20)), 12);
  const forged = insertBeforeDirectory(zip, extraEnd, extra);
  forged.writeUInt16LE(extraLength + extra.length, first.local + 28);
  assertRejectedBeforeSheetJS(forged);
});

test("matching small local/central lengths cannot conceal larger actual inflation", () => {
  const zip = workbook();
  const first = directory(zip).records[0];
  assert.ok(zip.readUInt32LE(first.central + 24) > 1);
  zip.writeUInt32LE(1, first.central + 24);
  zip.writeUInt32LE(1, first.local + 22);
  assertRejectedBeforeSheetJS(zip);
});

test("the per-disk entry count used by SheetJS must equal the validated total", () => {
  const zip = workbook();
  const end = directory(zip).end;
  zip.writeUInt16LE(zip.readUInt16LE(end + 10) + 1, end + 8);
  assertRejectedBeforeSheetJS(zip);
});

test("a later fake end signature cannot redirect SheetJS away from the validated directory", () => {
  const zip = workbook();
  zip.writeUInt16LE(4, directory(zip).end + 20);
  assertRejectedBeforeSheetJS(Buffer.concat([zip, Buffer.from([0x50, 0x4b, 0x05, 0x06])]));
});

test("local records must agree on method, flags, checksum, name and compressed range", () => {
  const original = workbook();
  const first = directory(original).records[0];
  const changes: Array<(zip: Buffer) => void> = [
    (zip) => zip.writeUInt16LE(0, first.local + 8),
    (zip) => zip.writeUInt16LE(1, first.local + 6),
    (zip) => zip.writeUInt32LE(0, first.local + 14),
    (zip) => { zip[first.local + 30] ^= 1; },
    (zip) => zip.writeUInt32LE(zip.length, first.local + 18),
    (zip) => zip.writeUInt32LE(directory(zip).start, first.central + 42),
  ];
  for (const mutate of changes) {
    const zip = Buffer.from(original);
    mutate(zip);
    assertRejectedBeforeSheetJS(zip);
  }
});

test("bounded DEFLATE with a streaming data descriptor remains supported", () => {
  const zip = workbook();
  const first = directory(zip).records[0];
  const dataEnd = first.local + 30 + zip.readUInt16LE(first.local + 26)
    + zip.readUInt16LE(first.local + 28) + zip.readUInt32LE(first.central + 20);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  zip.copy(descriptor, 4, first.central + 16, first.central + 28);
  const streaming = insertBeforeDirectory(zip, dataEnd, descriptor);
  streaming.writeUInt16LE(streaming.readUInt16LE(first.local + 6) | 8, first.local + 6);
  const newCentral = first.central + descriptor.length;
  streaming.writeUInt16LE(streaming.readUInt16LE(newCentral + 8) | 8, newCentral + 8);
  streaming.fill(0, first.local + 14, first.local + 26);
  assert.deepEqual(buildXlsxPreview(streaming)?.sheets[0].rows, [["safe"]]);
  const corruptDescriptor = Buffer.from(streaming);
  corruptDescriptor.writeUInt32LE(128 * 1024 * 1024, dataEnd + 12);
  assertRejectedBeforeSheetJS(corruptDescriptor);
});
