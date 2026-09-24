import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(["EACCES", "EISDIR", "EINVAL", "EPERM"]);

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && code && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(code)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Persist one complete generation without sharing a temporary path with another writer. */
export async function writeDurableTextFile(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(temporary, path);
    await syncDirectory(directory);

    if (await readFile(path, "utf8") !== value) {
      throw new Error("DURABLE_WRITE_READBACK_MISMATCH");
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
