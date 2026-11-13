import { Readable } from "node:stream";

import { __setCdnStorageForTests, resetStorageForTests, type StorageBackend } from "../services/storageService";

/**
 * An in-memory bucket installed as the logo storage (getCdnStorage) that
 * records every delete, for tests of when an App's logo object is deleted.
 * `restore()` puts the default storage back.
 */
export function installRecordingLogoStorage(): {
  objects: Map<string, Buffer>;
  deletes: string[];
  restore: () => void;
} {
  const objects = new Map<string, Buffer>();
  const deletes: string[] = [];
  const storage: StorageBackend = {
    put: async (key, data) => {
      objects.set(key, data);
    },
    get: async (key) => {
      const data = objects.get(key);
      if (!data) throw new Error(`No object at ${key}`);
      return Readable.from(data);
    },
    delete: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
  };
  __setCdnStorageForTests(storage);
  return { objects, deletes, restore: resetStorageForTests };
}
