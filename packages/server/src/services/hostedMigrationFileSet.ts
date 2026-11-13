import { getDirectUploadStorage, getStorage, type StorageBackend } from "./storageService";

/**
 * Where a hosted migration's import body is kept. New ones go to the dedicated
 * attachment bucket under `agent-migrations/v2/` (the company's account); a
 * deployment without that bucket keeps the main storage's key. The key is
 * persisted with the migration, so its prefix alone says which bucket to read
 * or delete it from: a body written before the move stays in the main storage.
 */
const FILE_SET_KEY_V2_PREFIX = "agent-migrations/v2/hosted/";

export function hostedMigrationFileSetKey(migrationId: string, dedicated = false): string {
  return dedicated
    ? `${FILE_SET_KEY_V2_PREFIX}${migrationId}/file-set.json`
    : `agent-migrations/hosted/${migrationId}/file-set.json`;
}

/** The bucket a file-set key lives in: the dedicated one for a v2 key, else the main storage. */
export function hostedMigrationFileSetStorage(
  key: string,
  storages: { dedicated: StorageBackend | null; main: StorageBackend | null } = { dedicated: getDirectUploadStorage(), main: getStorage() },
): StorageBackend | null {
  return key.startsWith(FILE_SET_KEY_V2_PREFIX) ? storages.dedicated : storages.main;
}
