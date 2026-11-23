// The one way the checks write a file under RAFT_HOME, a folder anything
// running as the Computer's user (agents included) can write to. The temp
// file has an unpredictable name and is created exclusively (O_CREAT|O_EXCL,
// which never follows a symlink planted at that name), so a planted file or
// symlink can never make the daemon write through it; it is removed when the
// rename does not happen.
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** `suffix` is for tests only (a known temp name); production always uses a random one. */
export async function writeJsonAtomic(filePath: string, value: unknown, suffix: string = randomUUID()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${suffix}.tmp`;
  // Fails with EEXIST on anything already there, a symlink included: nothing is written through it.
  const handle = await open(tmp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {});
  }
}
