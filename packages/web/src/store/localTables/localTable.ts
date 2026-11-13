// Local-first client tables (#triage:458d78f1, design v2 §4).
//
// One table holds one kind of record (servers, channels, actors, …) per scope:
// a user, or a user on one server. Rows live in memory; the persistence layer
// (IndexedDB, a separate module) listens to `onWrite` and calls `hydrate` at
// boot. Rules every caller can rely on:
//
// - Only server responses write: `upsert` (partial results: a realtime event,
//   one page, `/actors/resolve`), `replaceFromFullList` (a complete list: rows
//   missing from it are dropped), `remove` (a delete from the change feed).
//   A page or an on-demand lookup must never go through `replaceFromFullList`.
// - Each scope carries a freshness: `empty` (nothing yet), `local` (hydrated
//   from the device, waiting for the server) or `fresh` (a complete server
//   list arrived). Screens and refetches read it instead of guessing.
// - `hydrate` is ignored once the server has written to that scope, so a slow
//   device read never overwrites newer server data. It emits no write event.
// - Rows carry no sync positions: `lastSeq`, the sync horizon and the change
//   cursor are never stored here, so persisted data cannot move them.
// - Presence is not a table (design v2 §3): it is not persisted.

export type LocalTableName = "me" | "servers" | "channels" | "memberships" | "actors";

export type UserScope = { userId: string };
export type ServerScope = { userId: string; serverId: string };
export type LocalTableScope = UserScope | ServerScope;

export type LocalTableFreshness = "empty" | "local" | "fresh";

export type LocalTableWriteKind = "upsert" | "replace" | "remove" | "clear";

/**
 * A server-driven change. For `replace` and `clear` the scope's whole content
 * is now `list(scope)`; for `upsert` / `remove` only `keys` changed.
 */
export interface LocalTableWrite<S extends LocalTableScope = LocalTableScope> {
  table: LocalTableName;
  scope: S;
  kind: LocalTableWriteKind;
  keys: string[];
}

export interface LocalTable<Row, S extends LocalTableScope = LocalTableScope> {
  readonly name: LocalTableName;
  /**
   * Bump when the row shape changes, including the store type a row reuses
   * (`Channel`, `Server`, `User`); persisted rows of another schema are dropped.
   */
  readonly schema: number;
  readonly scopeKind: S extends ServerScope ? "server" : "user";
  keyOf(row: Row): string;

  get(scope: S, key: string): Row | undefined;
  /** Stable array: the same reference until the scope changes. */
  list(scope: S): readonly Row[];
  freshness(scope: S): LocalTableFreshness;
  /** Scopes of this user with rows, a freshness or a server write. */
  scopesOf(userId: string): S[];
  /** Called after any change to the scope, including hydrate. */
  subscribe(scope: S, listener: () => void): () => void;

  upsert(scope: S, rows: readonly Row[]): void;
  replaceFromFullList(scope: S, rows: readonly Row[]): void;
  remove(scope: S, keys: readonly string[]): void;
  /** Drops the scope entirely (sign-out, another user, a server left). */
  clear(scope: S): void;

  /** Device rows at boot. No-op once the server has written to the scope. */
  hydrate(scope: S, rows: readonly Row[]): void;
  /** Server-driven writes only; hydrate never shows up here. */
  onWrite(listener: (write: LocalTableWrite<S>) => void): () => void;
}

type ScopeState<Row> = {
  scope: LocalTableScope;
  rows: Map<string, Row>;
  freshness: LocalTableFreshness;
  serverWritten: boolean;
  listCache: readonly Row[] | null;
  listeners: Set<() => void>;
};

export function localTableScopeKey(scope: LocalTableScope): string {
  return "serverId" in scope ? `${scope.userId}:${scope.serverId}` : scope.userId;
}

export function createLocalTable<Row, S extends LocalTableScope>(options: {
  name: LocalTableName;
  schema: number;
  scopeKind: S extends ServerScope ? "server" : "user";
  keyOf: (row: Row) => string;
}): LocalTable<Row, S> {
  const scopes = new Map<string, ScopeState<Row>>();
  const writeListeners = new Set<(write: LocalTableWrite<S>) => void>();

  function stateOf(scope: S): ScopeState<Row> {
    assertScope(scope);
    const key = localTableScopeKey(scope);
    let state = scopes.get(key);
    if (!state) {
      state = {
        scope: { ...scope },
        rows: new Map(),
        freshness: "empty",
        serverWritten: false,
        listCache: null,
        listeners: new Set(),
      };
      scopes.set(key, state);
    }
    return state;
  }

  function assertScope(scope: S) {
    const isServer = "serverId" in scope;
    if (isServer !== (options.scopeKind === "server")) {
      throw new Error(`local table ${options.name} takes a ${options.scopeKind} scope`);
    }
  }

  function changed(state: ScopeState<Row>, write: LocalTableWrite<S> | null) {
    state.listCache = null;
    for (const listener of [...state.listeners]) listener();
    if (write) for (const listener of [...writeListeners]) listener(write);
  }

  function serverWrite(scope: S, kind: LocalTableWriteKind, keys: string[], apply: (state: ScopeState<Row>) => void) {
    const state = stateOf(scope);
    state.serverWritten = true;
    apply(state);
    changed(state, { table: options.name, scope: { ...scope }, kind, keys });
  }

  return {
    name: options.name,
    schema: options.schema,
    scopeKind: options.scopeKind,
    keyOf: options.keyOf,

    get(scope, key) {
      return scopes.get(localTableScopeKey(scope))?.rows.get(key);
    },

    list(scope) {
      const state = scopes.get(localTableScopeKey(scope));
      if (!state) return EMPTY;
      state.listCache ??= Object.freeze([...state.rows.values()]);
      return state.listCache;
    },

    freshness(scope) {
      return scopes.get(localTableScopeKey(scope))?.freshness ?? "empty";
    },

    scopesOf(userId) {
      const result: S[] = [];
      for (const state of scopes.values()) {
        if (state.scope.userId !== userId) continue;
        if (state.rows.size === 0 && state.freshness === "empty" && !state.serverWritten) continue;
        result.push({ ...state.scope } as S);
      }
      return result;
    },

    subscribe(scope, listener) {
      const state = stateOf(scope);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },

    upsert(scope, rows) {
      if (rows.length === 0) return;
      const state = stateOf(scope);
      const changedRows = new Map<string, Row>();
      for (const row of rows) {
        const key = options.keyOf(row);
        const existing = changedRows.get(key) ?? state.rows.get(key);
        // A refetch that says nothing new keeps the row (and every list) as it was.
        if (existing !== undefined && shallowEqualRows(existing, row)) continue;
        changedRows.set(key, row);
      }
      if (changedRows.size === 0) {
        // Still a server write: a later hydrate must not overwrite it.
        state.serverWritten = true;
        return;
      }
      serverWrite(scope, "upsert", [...changedRows.keys()], (s) => {
        for (const [key, row] of changedRows) s.rows.set(key, row);
        // A partial answer makes nothing fresh: rows not in it are unknown.
      });
    },

    replaceFromFullList(scope, rows) {
      const keys = rows.map(options.keyOf);
      serverWrite(scope, "replace", keys, (state) => {
        state.rows = new Map(rows.map((row, index) => [keys[index]!, row]));
        state.freshness = "fresh";
      });
    },

    remove(scope, keys) {
      const state = scopes.get(localTableScopeKey(scope));
      const present = state ? keys.filter((key) => state.rows.has(key)) : [];
      // Still counts as a server write: a later hydrate must not bring them back.
      serverWrite(scope, "remove", present, (s) => {
        for (const key of present) s.rows.delete(key);
      });
    },

    clear(scope) {
      const state = scopes.get(localTableScopeKey(scope));
      if (!state) return;
      // The state object stays so existing subscribers keep receiving changes.
      state.rows = new Map();
      state.freshness = "empty";
      state.serverWritten = false;
      changed(state, { table: options.name, scope: { ...scope }, kind: "clear", keys: [] });
    },

    hydrate(scope, rows) {
      const state = stateOf(scope);
      if (state.serverWritten) return;
      state.rows = new Map(rows.map((row) => [options.keyOf(row), row]));
      state.freshness = "local";
      changed(state, null);
    },

    onWrite(listener) {
      writeListeners.add(listener);
      return () => {
        writeListeners.delete(listener);
      };
    },
  };
}

const EMPTY: readonly never[] = Object.freeze([]);

function shallowEqualRows(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
    && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
