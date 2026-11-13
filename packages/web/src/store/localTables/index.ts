// The local tables of design v2 §4 (#triage:458d78f1). This module only
// declares them; screens move onto them one table at a time, and the
// persistence layer plugs in through `localTables()` + `onWrite` + `hydrate`.

import { useCallback, useSyncExternalStore } from "react";
import type { User } from "../authStore";
import type { Channel } from "../channelStore";
import type { Server } from "../serverStore";
import { createLocalTable } from "./localTable";
import type { LocalTable, LocalTableFreshness, LocalTableScope, ServerScope, UserScope } from "./localTable";

export * from "./localTable";

export type ActorKind = "human" | "agent";

/** A person or agent, including ones from another server seen through a joint channel. */
export interface ActorRow {
  kind: ActorKind;
  id: string;
  /** The server the actor belongs to; differs from the scope's server for external actors. */
  homeServerId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export type MembershipScopeKind = "channel" | "server";

export interface MembershipRow {
  scopeKind: MembershipScopeKind;
  scopeId: string;
  actorKind: ActorKind;
  actorId: string;
  role: string | null;
}

export function actorKey(kind: ActorKind, id: string): string {
  return `${kind}:${id}`;
}

export function membershipKey(row: Pick<MembershipRow, "scopeKind" | "scopeId" | "actorKind" | "actorId">): string {
  return `${row.scopeKind}:${row.scopeId}:${row.actorKind}:${row.actorId}`;
}

export const meTable = createLocalTable<User, UserScope>({
  name: "me",
  schema: 1,
  scopeKind: "user",
  keyOf: () => "me",
});

export const serversTable = createLocalTable<Server, UserScope>({
  name: "servers",
  schema: 1,
  scopeKind: "user",
  keyOf: (server) => server.id,
});

export const channelsTable = createLocalTable<Channel, ServerScope>({
  name: "channels",
  schema: 1,
  scopeKind: "server",
  keyOf: (channel) => channel.id,
});

export const membershipsTable = createLocalTable<MembershipRow, ServerScope>({
  name: "memberships",
  schema: 1,
  scopeKind: "server",
  keyOf: membershipKey,
});

export const actorsTable = createLocalTable<ActorRow, ServerScope>({
  name: "actors",
  schema: 1,
  scopeKind: "server",
  keyOf: (actor) => actorKey(actor.kind, actor.id),
});

type AnyLocalTable = LocalTable<unknown, LocalTableScope>;

const TABLES = [meTable, serversTable, channelsTable, membershipsTable, actorsTable] as unknown as readonly AnyLocalTable[];

/** Every table, so persistence and clearing cover a new one without a second list. */
export function localTables(): readonly AnyLocalTable[] {
  return TABLES;
}

const userGenerations = new Map<string, number>();

/**
 * Bumped by every clear of this user. Persistence reads it before an async
 * device read and hydrates only if it is unchanged, so a read that started
 * before sign-out never puts the previous user's rows back.
 */
export function userGeneration(userId: string): number {
  return userGenerations.get(userId) ?? 0;
}

/** Sign-out, session end, or another user signing in on another tab. */
export function clearLocalTablesForUser(userId: string): void {
  userGenerations.set(userId, userGeneration(userId) + 1);
  for (const table of TABLES) {
    for (const scope of table.scopesOf(userId)) table.clear(scope);
  }
}

/** Rows of one scope; re-renders when the scope changes. */
export function useLocalTableRows<Row, S extends LocalTableScope>(table: LocalTable<Row, S>, scope: S | null): readonly Row[] {
  const scopeId = scope ? JSON.stringify(scope) : null;
  const subscribe = useCallback(
    (listener: () => void) => (scope ? table.subscribe(scope, listener) : () => {}),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the scope's value, not its identity
    [table, scopeId],
  );
  const read = () => (scope ? table.list(scope) : NO_ROWS);
  return useSyncExternalStore(subscribe, read, read) as readonly Row[];
}

export function useLocalTableFreshness<S extends LocalTableScope>(table: LocalTable<unknown, S>, scope: S | null): LocalTableFreshness {
  const scopeId = scope ? JSON.stringify(scope) : null;
  const subscribe = useCallback(
    (listener: () => void) => (scope ? table.subscribe(scope, listener) : () => {}),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the scope's value, not its identity
    [table, scopeId],
  );
  const read = () => (scope ? table.freshness(scope) : "empty");
  return useSyncExternalStore(subscribe, read, read);
}

const NO_ROWS: readonly never[] = Object.freeze([]);
