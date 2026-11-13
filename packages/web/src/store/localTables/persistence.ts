// The local tables on the device (#triage:458d78f1, design v2 §4): what a
// table holds for the signed-in person is saved to IndexedDB and put back at
// the next boot, so a reopened link can show the last session before the
// server answers. Rules (docs/frontend/local-tables.md):
//
// - One record per table and scope, the scope's whole content, written a
//   moment after the server changed it. A clear deletes the record.
// - Hydrate only the person the stored session belongs to, and only if no
//   clear happened while the device was being read (userGeneration). Records
//   of anyone else are deleted at that point.
// - Sign-out, the end of the session and another person signing in on
//   another tab delete this person's records (forgetLocalUser).
// - A server that drops out of a full server list takes its scopes with it,
//   on the device and in memory.
// - Records of another schema, older than LOCAL_TABLES_MAX_AGE_MS, or past
//   LOCAL_TABLES_MAX_SERVERS servers are dropped.
// - Nothing here touches lastSeq, the sync horizon or a change cursor: the
//   tables hold none (localTable.ts).
// - `me` keeps only the profile fields the app shows (ME_FIELDS_KEPT).

import type { User } from "../authStore";
import { clearLocalTablesForUser, localTables, meTable, serversTable, userGeneration } from "./index";
import type { LocalTable, LocalTableName, LocalTableScope, LocalTableWrite } from "./localTable";
import { localTableScopeKey } from "./localTable";
import { indexedDbLocalTableStore } from "./persistenceIndexedDb";

export const LOCAL_TABLES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCAL_TABLES_MAX_SERVERS = 10;
const SAVE_DELAY_MS = 300;

export interface LocalTableRecord {
  /** `${table}|${scopeKey}` */
  id: string;
  table: LocalTableName;
  schema: number;
  userId: string;
  serverId: string | null;
  savedAt: number;
  rows: unknown[];
}

/** Where records live: IndexedDB in the app, memory in tests. Every call may fail; failures lose the cache, never data. */
export interface LocalTableStore {
  listUser(userId: string): Promise<LocalTableRecord[]>;
  listUserIds(): Promise<string[]>;
  put(record: LocalTableRecord): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

type AnyTable = LocalTable<unknown, LocalTableScope>;

// The person's row keeps what the app shows; the sign-up survey, referral
// answers, observed time zones and one-off hints stay off the device (any
// field the server adds later too). Required fields left out are kept as null.
const ME_FIELDS_KEPT = [
  "id",
  "email",
  "name",
  "displayName",
  "description",
  "avatarUrl",
  "emailVerified",
  "profileSetupCompletedAt",
  "preferredLanguage",
  "displayLanguage",
  "preferredTimezone",
  "autoTranslationEnabled",
  "preferredTranslationMode",
  "preferredTranslationDisplay",
  "preferredTimeFormat",
  "preferredMessageBodyFontSize",
  "railTabOrder",
  "composerSendKey",
  "shareUsageData",
] as const satisfies readonly (keyof User)[];

function storedRow(table: LocalTableName, row: unknown): unknown {
  if (table !== "me") return row;
  const user = row as User;
  const kept: Partial<User> = { referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null };
  for (const field of ME_FIELDS_KEPT) {
    if (field in user) (kept as Record<string, unknown>)[field] = user[field];
  }
  return kept;
}

function recordId(table: LocalTableName, scope: LocalTableScope): string {
  return `${table}|${localTableScopeKey(scope)}`;
}

function scopeOf(record: LocalTableRecord): LocalTableScope {
  return record.serverId === null ? { userId: record.userId } : { userId: record.userId, serverId: record.serverId };
}

export interface LocalTablePersistence {
  /**
   * Puts this person's saved tables back and deletes everyone else's;
   * without a session, deletes everything. Resolves when done (or failed).
   */
  hydrate(userId: string | null): Promise<void>;
  /** Deletes this person's tables, in memory and on the device. */
  forget(userId: string): Promise<void>;
  /** Writes what is waiting (tests; the page going away). */
  flush(): Promise<void>;
  stop(): void;
}

export function createLocalTablePersistence(
  store: LocalTableStore,
  options: { now?: () => number; tables?: readonly AnyTable[] } = {},
): LocalTablePersistence {
  const now = options.now ?? Date.now;
  const tables = options.tables ?? localTables();
  const byName = new Map(tables.map((table) => [table.name, table]));
  const dirty = new Map<string, { table: AnyTable; scope: LocalTableScope }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingWork: Promise<unknown> = Promise.resolve();

  const run = (work: () => Promise<unknown>) => {
    pendingWork = pendingWork.then(work).catch(() => {});
    return pendingWork;
  };

  function save(): Promise<unknown> {
    timer = null;
    const batch = [...dirty.values()];
    dirty.clear();
    return run(async () => {
      for (const { table, scope } of batch) {
        await store.put({
          id: recordId(table.name, scope),
          table: table.name,
          schema: table.schema,
          userId: scope.userId,
          serverId: "serverId" in scope ? scope.serverId : null,
          savedAt: now(),
          rows: table.list(scope).map((row) => storedRow(table.name, row)),
        });
      }
    });
  }

  function dropServers(userId: string, kept: ReadonlySet<string>) {
    for (const table of tables) {
      for (const scope of table.scopesOf(userId)) {
        if ("serverId" in scope && !kept.has(scope.serverId)) table.clear(scope);
      }
    }
    void run(async () => {
      const gone = (await store.listUser(userId)).filter((record) => record.serverId !== null && !kept.has(record.serverId));
      await store.delete(gone.map((record) => record.id));
    });
  }

  function onWrite(table: AnyTable, write: LocalTableWrite) {
    const id = recordId(table.name, write.scope);
    if (write.kind === "clear") {
      dirty.delete(id);
      void run(() => store.delete([id]));
      return;
    }
    dirty.set(id, { table, scope: write.scope });
    timer ??= setTimeout(() => void save(), SAVE_DELAY_MS);
    if (table.name === serversTable.name && write.kind === "replace") {
      dropServers(write.scope.userId, new Set(write.keys));
    }
  }

  const unsubscribes = tables.map((table) => table.onWrite((write) => onWrite(table, write)));

  return {
    async hydrate(userId) {
      const generation = userId ? userGeneration(userId) : 0;
      let records: LocalTableRecord[];
      try {
        // A sign-out whose delete did not finish before the page left, or
        // another person on this device: only the session's person stays.
        const others = (await store.listUserIds()).filter((id) => id !== userId);
        for (const other of others) await store.deleteUser(other);
        if (!userId) return;
        records = await store.listUser(userId);
      } catch {
        return;
      }
      if (userGeneration(userId) !== generation) return;
      const cutoff = now() - LOCAL_TABLES_MAX_AGE_MS;
      const stale: string[] = [];
      const usable = records.filter((record) => {
        const table = byName.get(record.table);
        const ok = table !== undefined && record.schema === table.schema && record.savedAt >= cutoff && Array.isArray(record.rows);
        if (!ok) stale.push(record.id);
        return ok;
      });
      // The servers saved most recently, at most LOCAL_TABLES_MAX_SERVERS.
      const lastSaved = new Map<string, number>();
      for (const record of usable) {
        if (record.serverId !== null) lastSaved.set(record.serverId, Math.max(lastSaved.get(record.serverId) ?? 0, record.savedAt));
      }
      const keptServers = new Set(
        [...lastSaved.entries()].sort((a, b) => b[1] - a[1]).slice(0, LOCAL_TABLES_MAX_SERVERS).map(([serverId]) => serverId),
      );
      for (const record of usable) {
        if (record.serverId !== null && !keptServers.has(record.serverId)) {
          stale.push(record.id);
          continue;
        }
        byName.get(record.table)!.hydrate(scopeOf(record), record.rows);
      }
      if (stale.length > 0) void run(() => store.delete(stale));
    },

    async forget(userId) {
      clearLocalTablesForUser(userId);
      for (const table of tables) for (const scope of table.scopesOf(userId)) table.clear(scope);
      for (const [id, entry] of dirty) if (entry.scope.userId === userId) dirty.delete(id);
      await run(() => store.deleteUser(userId));
    },

    async flush() {
      if (timer !== null) clearTimeout(timer);
      await save();
    },

    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}

let appPersistence: LocalTablePersistence | null = null;

function persistence(): LocalTablePersistence {
  appPersistence ??= createLocalTablePersistence(indexedDbLocalTableStore());
  return appPersistence;
}

/** Boot (main.tsx): puts the stored session's tables back; without a session, clears the device. */
export function hydrateLocalTables(userId: string | null): Promise<void> {
  return persistence().hydrate(userId);
}

/** Sign-out, the end of the session, another person on another tab. */
export function forgetLocalUser(userId: string | null): void {
  if (!userId) return;
  void persistence().forget(userId);
}

/** The page is going away: write what is waiting. */
export function flushLocalTables(): void {
  void appPersistence?.flush();
}

/** `me` row as it is kept on the device (tests). */
export const __storedMeRowForTest = (row: User) => storedRow(meTable.name, row);
