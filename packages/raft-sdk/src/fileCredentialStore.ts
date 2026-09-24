import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { RaftSdkConfigurationError } from "./client.js";
import {
  parseStoredRaftCredential,
  RaftCredentialError,
  type RaftCredentialStore,
  type StoredRaftCredential,
} from "./credential.js";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

/**
 * Create a Node.js credential store at one explicit absolute path. The SDK
 * never discovers CLI profiles or a home directory. Writes use a same-directory
 * temporary file followed by atomic rename, and the final file is mode 0600.
 */
export function createFileCredentialStore(filePath: string): RaftCredentialStore {
  if (!filePath.trim() || !isAbsolute(filePath)) {
    throw new RaftSdkConfigurationError(
      "INVALID_CREDENTIAL_PATH",
      "Raft credential file path must be an explicit absolute path",
    );
  }

  return {
    load: () => loadFileCredential(filePath),

    async save(record: StoredRaftCredential): Promise<void> {
      const validated = parseStoredRaftCredential(record);
      if (!validated) {
        throw new RaftCredentialError(
          "CREDENTIAL_STORE_WRITE_FAILED",
          "Refusing to write an invalid Raft Agent credential record",
        );
      }

      const directory = dirname(filePath);
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const existing = await loadFileCredential(filePath);
        if (existing) {
          assertSameCredential(existing, validated);
          return;
        }

        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
        await handle.sync();
        await chmod(temporaryPath, 0o600);
        await handle.close();
        handle = undefined;
        try {
          await link(temporaryPath, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const winner = await loadFileCredential(filePath);
          if (!winner) throw error;
          assertSameCredential(winner, validated);
        }
        await unlink(temporaryPath);
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
        }
        await unlink(temporaryPath).catch(() => undefined);
        if (error instanceof RaftCredentialError) throw error;
        throw new RaftCredentialError(
          "CREDENTIAL_STORE_WRITE_FAILED",
          "The Raft Agent credential could not be written atomically",
        );
      }
    },
  };
}

async function loadFileCredential(filePath: string): Promise<StoredRaftCredential | null> {
  let initialMetadata;
  try {
    initialMetadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw fileReadError();
  }
  if (
    !initialMetadata.isFile()
    || initialMetadata.isSymbolicLink()
    || initialMetadata.size > MAX_CREDENTIAL_FILE_BYTES
  ) {
    throw fileReadError();
  }

  let parsed: unknown;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile()
      || openedMetadata.size > MAX_CREDENTIAL_FILE_BYTES
      || initialMetadata.dev !== openedMetadata.dev
      || initialMetadata.ino !== openedMetadata.ino
    ) {
      throw fileReadError();
    }
    if (process.platform !== "win32" && (openedMetadata.mode & 0o077) !== 0) {
      throw new RaftCredentialError(
        "CREDENTIAL_STORE_READ_FAILED",
        "The Raft credential file permissions are too broad; expected mode 0600",
      );
    }
    parsed = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof RaftCredentialError) throw error;
    throw fileReadError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const record = parseStoredRaftCredential(parsed);
  if (!record) throw fileReadError();
  return record;
}

function assertSameCredential(
  existing: StoredRaftCredential,
  candidate: StoredRaftCredential,
): void {
  if (existing.credential !== candidate.credential) {
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_CONFLICT",
      "The credential store already contains a different Raft Agent credential",
    );
  }
}

function fileReadError(): RaftCredentialError {
  return new RaftCredentialError(
    "CREDENTIAL_STORE_READ_FAILED",
    "The Raft credential file is invalid or unreadable",
  );
}
