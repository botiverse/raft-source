// Actors this client has heard of: the writers that copy server answers
// (members, agents, channel rosters) into `actorsTable`, and the on-demand
// resolver for senders no roster carries (a joint channel's other server).
//
// The resolver asks `POST /actors/resolve` for the refs a screen is missing,
// batched (one short debounce, chunks of the shared ACTOR_RESOLVE_MAX_ACTORS) and asked once per scope: an id
// the server leaves out of its answer (not visible, gone) is not asked again
// until the server is reset. A 403 (guest) or 404 (a server without the
// endpoint) turns it off for that scope; any other failure only marks the
// refs as asked, so nothing retries in a loop. Callers ask only for senders
// that are plausibly another server's (joint channels); a ref a local roster
// knows by flush time is dropped from the batch.

import { isAxiosError } from "axios";
import { ACTOR_RESOLVE_MAX_ACTORS } from "@botiverse/raft-shared";
import type { ActorResolveRequest, ActorUpdatedEvent } from "@botiverse/raft-shared";
import api from "../../api/client";
import { registerServerReset } from "../serverResetRegistry";
import { useServerStore } from "../serverStore";
import { actorKey, actorsTable } from "./index";
import type { ActorKind, ActorRow } from "./index";
import type { ServerScope } from "./localTable";
import { localTableScopeKey } from "./localTable";

export interface ActorRef {
  kind: ActorKind;
  id: string;
}

const ACTOR_RESOLVE_DEBOUNCE_MS = 50;
// The server validates every ref id as a UUID: one malformed id would fail the whole batch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The auth store registers this (it imports the server store, so the store
// layer cannot import it back). Unregistered: no signed-in user, no scope.
let signedInUserId: (() => string | null | undefined) | null = null;

export function setActorScopeUserIdGetter(getter: (() => string | null | undefined) | null): void {
  signedInUserId = getter;
}

/** The signed-in user on the current server, or null before either is known. */
export function currentActorScope(): ServerScope | null {
  const userId = signedInUserId?.();
  const serverId = useServerStore.getState().current?.id;
  return userId && serverId ? { userId, serverId } : null;
}

/** True while `scope` is still the signed-in user's current server. */
export function isCurrentActorScope(scope: ServerScope): boolean {
  const current = currentActorScope();
  return current !== null && current.userId === scope.userId && current.serverId === scope.serverId;
}

// Live rosters (agent directory, member list) register here, so the resolver
// can drop refs they learned while a batch waited without importing them.
const localActorLookups = new Set<(ref: ActorRef) => boolean>();

export function registerLocalActorLookup(lookup: (ref: ActorRef) => boolean): () => void {
  localActorLookups.add(lookup);
  return () => {
    localActorLookups.delete(lookup);
  };
}

function knownLocally(ref: ActorRef): boolean {
  for (const lookup of localActorLookups) if (lookup(ref)) return true;
  return false;
}

type HumanSource = {
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  serverId?: string | null;
};

/**
 * A person from a members list or a channel roster. `defaultHomeServerId` is
 * for sources that are genuinely this server's (its members list); elsewhere a
 * person without a serverId is skipped rather than guessed.
 */
export function humanActorRow(id: string, human: HumanSource, defaultHomeServerId: string | null = null): ActorRow | null {
  const homeServerId = human.serverId ?? defaultHomeServerId;
  if (!id || homeServerId == null) return null;
  return {
    kind: "human",
    id,
    homeServerId,
    name: human.name,
    displayName: human.displayName ?? null,
    avatarUrl: human.avatarUrl ?? null,
  };
}

/** An agent from `/agents`, `/agents/:id` or a channel roster; same rule for a missing serverId. */
export function agentActorRow(
  agent: { id: string; name: string; displayName: string | null; avatarUrl: string | null; serverId?: string | null },
  defaultHomeServerId: string | null = null,
): ActorRow | null {
  const homeServerId = agent.serverId || defaultHomeServerId;
  if (!agent.id || !homeServerId) return null;
  return {
    kind: "agent",
    id: agent.id,
    homeServerId,
    name: agent.name,
    displayName: agent.displayName ?? null,
    avatarUrl: agent.avatarUrl ?? null,
  };
}

/** Upsert server-answered rows, but only into the scope that is still current. */
export function upsertActorsIfCurrent(scope: ServerScope | null, rows: readonly (ActorRow | null)[]): void {
  if (!scope || !isCurrentActorScope(scope)) return;
  const present = rows.filter((row): row is ActorRow => row !== null);
  if (present.length > 0) actorsTable.upsert(scope, present);
}

type ScopeResolveState = {
  scope: ServerScope;
  asked: Set<string>;
  pending: Map<string, ActorRef>;
  timer: ReturnType<typeof setTimeout> | null;
  disabled: boolean;
};

const resolveStates = new Map<string, ScopeResolveState>();

function resolveStateOf(scope: ServerScope): ScopeResolveState {
  const key = localTableScopeKey(scope);
  let state = resolveStates.get(key);
  if (!state) {
    state = { scope: { ...scope }, asked: new Set(), pending: new Map(), timer: null, disabled: false };
    resolveStates.set(key, state);
  }
  return state;
}

/**
 * Asks the server for actors this scope has no row for. Cheap to call from
 * render effects: refs with a row, already asked, or already queued are skipped.
 */
export function requestActors(scope: ServerScope, refs: readonly ActorRef[]): void {
  const state = resolveStateOf(scope);
  if (state.disabled) return;
  for (const ref of refs) {
    if (!UUID_RE.test(ref.id)) continue;
    const key = actorKey(ref.kind, ref.id);
    if (state.asked.has(key) || state.pending.has(key)) continue;
    if (actorsTable.get(scope, key)) continue;
    state.pending.set(key, { kind: ref.kind, id: ref.id });
  }
  if (state.pending.size === 0 || state.timer) return;
  state.timer = setTimeout(() => flush(state), ACTOR_RESOLVE_DEBOUNCE_MS);
}

function isLive(state: ScopeResolveState): boolean {
  return resolveStates.get(localTableScopeKey(state.scope)) === state;
}

function flush(state: ScopeResolveState) {
  state.timer = null;
  if (!isLive(state)) return;
  const refs: ActorRef[] = [];
  for (const [key, ref] of state.pending) {
    // A roster may have filled it while the batch waited; it is not asked
    // either, so it stays askable if that roster later drops it.
    if (actorsTable.get(state.scope, key) || knownLocally(ref)) continue;
    state.asked.add(key);
    refs.push(ref);
  }
  state.pending.clear();
  for (let start = 0; start < refs.length; start += ACTOR_RESOLVE_MAX_ACTORS) {
    void resolveChunk(state, refs.slice(start, start + ACTOR_RESOLVE_MAX_ACTORS));
  }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * One entry of the answer, checked field by field; anything malformed is
 * dropped. Not the shared `resolvedActorSchema`: it is strict, so a field a
 * newer server adds would make this client drop the row. The deprecated
 * `gravatarHash` an older server sends is ignored, whatever its value.
 */
function parseResolvedActor(value: unknown): ActorRow | null {
  if (typeof value !== "object" || value === null) return null;
  const actor = value as Record<string, unknown>;
  const { kind, id, homeServerId, name, displayName, avatarUrl } = actor;
  if (kind !== "human" && kind !== "agent") return null;
  if (typeof id !== "string" || !id || typeof homeServerId !== "string" || (kind === "agent" && !homeServerId)) return null;
  if (typeof name !== "string" || !nullableString(displayName) || !nullableString(avatarUrl)) return null;
  return { kind, id, homeServerId, name, displayName, avatarUrl };
}

/**
 * `actor:updated`: an agent from another server, seen here through a joint
 * channel, changed its display identity. The payload is the external
 * projection (shared ActorUpdatedEvent); a malformed one, or one for a human,
 * is dropped. It refreshes the current scope's row only: the agent directory
 * (`/agents`) is this server's own and is not re-read for it.
 */
export function applyActorUpdatedEvent(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const { kind, id, homeServerId, name, displayName, avatarUrl } = payload as Record<string, unknown>;
  if (kind !== "agent") return;
  if (typeof id !== "string" || !UUID_RE.test(id) || typeof homeServerId !== "string" || !UUID_RE.test(homeServerId)) return;
  if (typeof name !== "string" || !nullableString(displayName) || !nullableString(avatarUrl)) return;
  const event: ActorUpdatedEvent = { kind, id, homeServerId, name, displayName, avatarUrl };
  upsertActorsIfCurrent(currentActorScope(), [agentActorRow({ ...event, serverId: event.homeServerId })]);
}

async function resolveChunk(state: ScopeResolveState, refs: ActorRef[]) {
  if (state.disabled) return;
  try {
    const { data } = await api.post(
      "/actors/resolve",
      { actors: refs } satisfies ActorResolveRequest,
      { headers: { "X-Server-Id": state.scope.serverId } },
    );
    // A server reset or sign-out since the request: its answer is for a scope nobody reads now.
    if (!isLive(state)) return;
    const actors: unknown = (data as { actors?: unknown } | null)?.actors;
    if (!Array.isArray(actors)) return;
    upsertActorsIfCurrent(state.scope, actors.map(parseResolvedActor));
  } catch (error) {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    // 404: an older server without the endpoint. 403: a guest may not look people up.
    if (status === 404 || status === 403) {
      state.disabled = true;
      return;
    }
    console.warn(`actors/resolve failed for ${refs.length} actor(s); not retried`, status ?? error);
  }
}

/** Forget every asked ref and pending batch (server reset, sign-out, tests). */
export function resetActorResolve(): void {
  for (const state of resolveStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  resolveStates.clear();
}

registerServerReset(resetActorResolve);
