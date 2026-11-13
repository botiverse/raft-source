// A zip of an Artifact version's files for the signed-out `download.zip`
// route (publicRoutes.ts). The server has no zip dependency, so a minimal
// writer: STORE only (no compression; most bytes worth zipping here are
// small text, and the archive is a download, not storage), no Zip64 (the
// route caps the total far below 4 GiB), UTF-8 names (general purpose bit
// 11). Each file is read whole (at most one file's size in memory, the
// publish limit of 16 MiB) to know its CRC-32 before its local header, so
// no data descriptors: every unzip reads it, streaming ones too. The size
// is known before the first byte (storedZipSize), so the answer has a
// Content-Length.
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export interface StoredZipEntry {
  /** The path inside the archive (an Artifact file path: no leading slash, no `..`). */
  name: string;
  size: number;
  /** The file's bytes, read when the archive reaches it; exactly `size` of them.
   * A canceled archive aborts the read, including a pending storage request. */
  read(signal?: AbortSignal): Promise<Buffer>;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_OF_CENTRAL_DIRECTORY = 22;
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
/** UTF-8 names. */
const FLAGS = 0x0800;
const STORE = 0;
const VERSION = 20;

/** The archive's length in bytes for these entries. */
export function storedZipSize(entries: ReadonlyArray<Pick<StoredZipEntry, "name" | "size">>): number {
  let total = END_OF_CENTRAL_DIRECTORY;
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.name, "utf8");
    total += LOCAL_HEADER + name + entry.size + CENTRAL_HEADER + name;
  }
  return total;
}

/** MS-DOS time and date of `at` (UTC; two-second resolution, 1980 at the earliest). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * The archive of `entries`, in order, as a stream of exactly
 * storedZipSize(entries) bytes. A file whose bytes aren't `size` long fails
 * the stream (the answer is cut, never a corrupt archive passed as whole).
 */
export function storedZip(entries: readonly StoredZipEntry[], modifiedAt: Date): Readable {
  if (entries.length > MAX_ENTRIES) throw new Error("too many entries for a zip without Zip64");
  if (storedZipSize(entries) > MAX_OFFSET) throw new Error("too large for a zip without Zip64");
  const { time, date } = dosDateTime(modifiedAt);
  const reads = new AbortController();
  async function* chunks(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const bytes = await readEntry(entry, reads.signal);
      if (bytes.length !== entry.size) throw new Error(`zip entry ${entry.name} is ${bytes.length} bytes, not ${entry.size}`);
      const crc = crc32(bytes);
      const local = Buffer.alloc(LOCAL_HEADER);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(FLAGS, 6);
      local.writeUInt16LE(STORE, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(bytes.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      yield local;
      yield name;
      yield bytes;
      const header = Buffer.alloc(CENTRAL_HEADER);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt16LE(FLAGS, 8);
      header.writeUInt16LE(STORE, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(bytes.length, 20);
      header.writeUInt32LE(bytes.length, 24);
      header.writeUInt16LE(name.length, 28);
      // Extra field, comment, disk number, internal attributes: none.
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      offset += LOCAL_HEADER + name.length + bytes.length;
    }
    const directory = Buffer.concat(central);
    yield directory;
    const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
  }
  const stream = Readable.from(chunks(), { objectMode: false });
  const destroyIterator = stream._destroy.bind(stream);
  // Readable.from's destroy waits for iterator.return(). An async generator
  // cannot return while its current read is pending: cancel that await first,
  // then let the original destroy finish and close the HTTP pipeline.
  stream._destroy = (error, callback) => {
    reads.abort();
    destroyIterator(error, callback);
  };
  return stream;
}

/** Do not await an uncooperative reader after cancellation. Cooperative
 * readers also receive the signal, so the real storage request is aborted. */
function readEntry(entry: StoredZipEntry, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const canceled = () => {
      signal.removeEventListener("abort", canceled);
      reject(signal.reason);
    };
    signal.addEventListener("abort", canceled, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return entry.read(signal); }).then(
      (bytes) => { signal.removeEventListener("abort", canceled); resolve(bytes); },
      (error: unknown) => { signal.removeEventListener("abort", canceled); reject(error); },
    );
  });
}
