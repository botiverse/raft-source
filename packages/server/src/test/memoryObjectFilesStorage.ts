import { Readable } from "node:stream";

import { AppObjectStorageUnavailableError, type AppObjectStorage } from "../services/appObjectStorage";
import { __setObjectFilesStorageForTests } from "../services/objectFiles";

/**
 * An in-memory bucket installed as core's object files storage
 * (services/objectFiles.ts), keyed by the relative key core names. `failDeletes`
 * makes every delete reject (the bytes stay); `configured: false` is the
 * platform's bucket missing. `restore()` puts the bucket back.
 */
export function installMemoryObjectFilesStorage(opts: { configured?: boolean } = {}): {
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  failDeletes: { on: boolean };
  restore: () => void;
} {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const failDeletes = { on: false };
  const configured = opts.configured ?? true;
  const available = () => {
    if (!configured) throw new AppObjectStorageUnavailableError();
  };
  const storage: AppObjectStorage = {
    configured,
    async put(key, bytes, contentType) {
      available();
      objects.set(key, { bytes, contentType });
    },
    async get(key) {
      available();
      const object = objects.get(key);
      return object ? Readable.from([object.bytes]) : null;
    },
    async delete(key) {
      available();
      if (failDeletes.on) throw new Error("delete failed (test)");
      objects.delete(key);
    },
    async presignGet(key) {
      available();
      return `https://objects.example.test/${key}`;
    },
  };
  __setObjectFilesStorageForTests(storage);
  return { objects, failDeletes, restore: () => __setObjectFilesStorageForTests(undefined) };
}
