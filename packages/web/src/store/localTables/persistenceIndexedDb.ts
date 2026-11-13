// IndexedDB under the local tables' persistence (persistence.ts). One object
// store of records keyed by `${table}|${scope}`, indexed by user. Without
// IndexedDB (private windows of some browsers, blocked storage) every call
// fails and the app simply starts without a cache.

import type { LocalTableRecord, LocalTableStore } from "./persistence";

const DB_NAME = "raft-local-tables";
const DB_VERSION = 1;
const RECORDS = "records";
const BY_USER = "userId";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no IndexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore(RECORDS, { keyPath: "id" });
      records.createIndex(BY_USER, BY_USER);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema: let it, and open again next time.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function indexedDbLocalTableStore(): LocalTableStore {
  return {
    async listUser(userId) {
      const db = await open();
      const index = db.transaction(RECORDS, "readonly").objectStore(RECORDS).index(BY_USER);
      return (await done(index.getAll(IDBKeyRange.only(userId)))) as LocalTableRecord[];
    },

    async listUserIds() {
      const db = await open();
      const ids: string[] = [];
      const cursor = db.transaction(RECORDS, "readonly").objectStore(RECORDS).index(BY_USER).openKeyCursor(null, "nextunique");
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) {
            resolve();
            return;
          }
          ids.push(String(current.key));
          current.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return ids;
    },

    async put(record) {
      const db = await open();
      const transaction = db.transaction(RECORDS, "readwrite");
      transaction.objectStore(RECORDS).put(record);
      await committed(transaction);
    },

    async delete(ids) {
      if (ids.length === 0) return;
      const db = await open();
      const transaction = db.transaction(RECORDS, "readwrite");
      const records = transaction.objectStore(RECORDS);
      for (const id of ids) records.delete(id);
      await committed(transaction);
    },

    async deleteUser(userId) {
      const db = await open();
      const transaction = db.transaction(RECORDS, "readwrite");
      // Deleted from the cursor's own callbacks, so the transaction never goes idle in between.
      const cursor = transaction.objectStore(RECORDS).index(BY_USER).openCursor(IDBKeyRange.only(userId));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        current.delete();
        current.continue();
      };
      await committed(transaction);
    },
  };
}
