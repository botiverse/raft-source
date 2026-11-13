import { onDraftsForgotten } from "./draftStorage";

/**
 * What was open beside each conversation, per person and server, kept on
 * this device (docs/frontend/beside-memory.md): switching channels keeps
 * what was open beside the conversation.
 *
 * - One localStorage entry per person and server
 *   (`raft:beside-memory:v1:<userId>:<serverId>`), holding at most
 *   BESIDE_MEMORY_MAX_CONVERSATIONS conversations, the least recently
 *   written dropped first. Never synced.
 * - Remembered: which things are open (a thread, an Artifact with its pinned
 *   version, a profile with its tab) and which one is in front. Not widths
 *   (columnWidthStore, channelSideLayoutStore keep those) and nothing live.
 * - A conversation with nothing remembered has no entry: returning opens
 *   nothing. A thing is forgotten when the person closes it, or when it is
 *   found no longer visible; an entry that merely doesn't show it (Back onto
 *   an older entry, a phone's layout) forgets nothing (useBesideMemory.ts).
 * - Data that doesn't parse, or of another version, reads as nothing; a
 *   storage that throws is treated as empty and never written.
 * - Sign-out removes every entry of that person (all servers).
 *
 * The values are the address's own (besideAddress.ts reads and writes them):
 * this module knows nothing of the router, so it stays a pure store.
 */
export const BESIDE_MEMORY_STORAGE_PREFIX = "raft:beside-memory:v1:";
export const BESIDE_MEMORY_MAX_CONVERSATIONS = 200;

const VERSION = 1;
/** Front to back where nothing says otherwise. */
export const BESIDE_KINDS = ["thread", "artifact", "profile"] as const;
export type BesideKind = typeof BESIDE_KINDS[number];

export interface BesideState {
  /** The open thread's parent message (the thread is always the conversation's own). */
  thread?: string;
  /** The open Artifact as its address names it, and its pinned version (null: the latest). */
  artifact?: { id: string; version: number | null };
  /** The open profile as its address names it: `agent:<id>`, `human:<id>`, `computer:<id>`. */
  profile?: string;
  /** The agent profile's tab. */
  agentTab?: string;
  /** Which of the open ones is in front. */
  front?: BesideKind;
}

interface StoredEntry extends BesideState {
  /** When it was last written (ms): the oldest go first. */
  at: number;
}

interface Stored {
  v: typeof VERSION;
  conversations: Record<string, StoredEntry>;
}

const ID = /^[0-9A-Za-z_-]+$/;
const PROFILE = /^(?:agent|human|computer):[0-9A-Za-z_-]+$/;
const TAB = /^[0-9A-Za-z_-]{1,64}$/;

export function besideKindsOf(state: BesideState | null | undefined): BesideKind[] {
  return state ? BESIDE_KINDS.filter((kind) => state[kind] !== undefined) : [];
}

export function isBesideEmpty(state: BesideState | null | undefined): boolean {
  return besideKindsOf(state).length === 0;
}

function sameValue(a: BesideState, b: BesideState, kind: BesideKind): boolean {
  if (kind === "artifact") return a.artifact?.id === b.artifact?.id && a.artifact?.version === b.artifact?.version;
  return a[kind] === b[kind];
}

export function sameBeside(a: BesideState | null, b: BesideState | null): boolean {
  const left = a ?? {};
  const right = b ?? {};
  return BESIDE_KINDS.every((kind) => sameValue(left, right, kind))
    && (left.agentTab ?? null) === (right.agentTab ?? null)
    && (left.front ?? null) === (right.front ?? null);
}

/**
 * A stored or built value as a state: only well-formed parts, a tab only
 * with an agent's profile, and a front only among what is open (else the
 * first open one in BESIDE_KINDS' order).
 */
export function normalizeBeside(value: unknown): BesideState {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const state: BesideState = {};
  if (typeof raw.thread === "string" && ID.test(raw.thread)) state.thread = raw.thread;
  const artifact = raw.artifact as { id?: unknown; version?: unknown } | null | undefined;
  if (artifact && typeof artifact === "object" && typeof artifact.id === "string" && ID.test(artifact.id)) {
    const version = typeof artifact.version === "number" && Number.isSafeInteger(artifact.version) && artifact.version > 0 ? artifact.version : null;
    state.artifact = { id: artifact.id, version };
  }
  if (typeof raw.profile === "string" && PROFILE.test(raw.profile)) {
    state.profile = raw.profile;
    if (raw.profile.startsWith("agent:") && typeof raw.agentTab === "string" && TAB.test(raw.agentTab)) state.agentTab = raw.agentTab;
  }
  const open = besideKindsOf(state);
  const front = open.find((kind) => kind === raw.front) ?? open[0];
  if (front) state.front = front;
  return state;
}

/**
 * What to remember once the address shows `current`, having shown `previous`:
 * `picked` (a tab the person chose) is in front if it is open; else whatever
 * just opened or changed; else what was in front, if still open.
 */
export function nextBesideState(previous: BesideState | null, current: BesideState, picked: BesideKind | null = null): BesideState {
  const before = previous ?? {};
  const open = besideKindsOf(current);
  const opened = open.filter((kind) => !sameValue(before, current, kind));
  const front = (picked && open.includes(picked) ? picked : undefined)
    ?? opened[0]
    ?? (before.front && open.includes(before.front) ? before.front : undefined);
  return normalizeBeside({ ...current, front });
}

export interface BesideRestorePlan {
  /** The remembered things the address doesn't name: to check, then open behind what it names. */
  restore: BesideState;
  /** What is in front once they are open: what the address names, else what was remembered in front. */
  front: BesideKind | null;
}

/**
 * The address wins: every kind it names (`named`) is kept as it is and stays
 * in front; the remembered kinds it doesn't name are restored behind. An
 * address that names nothing restores the remembered state as it was.
 * `threadTaken`: the address has the thread's place for something else, so
 * no remembered thread is restored: a `?thread=` of any shape (one of
 * another conversation is a link the layout rejects whole), or `?msg=`, a
 * message of the conversation itself, which a thread would take for one of
 * its replies.
 */
export function planBesideRestore(remembered: BesideState | null, named: BesideState, { threadTaken = false }: { threadTaken?: boolean } = {}): BesideRestorePlan {
  const kept = normalizeBeside(remembered);
  const restore: BesideState = {};
  if (kept.thread !== undefined && named.thread === undefined && !threadTaken) restore.thread = kept.thread;
  if (kept.artifact !== undefined && named.artifact === undefined) restore.artifact = kept.artifact;
  if (kept.profile !== undefined && named.profile === undefined) {
    restore.profile = kept.profile;
    if (kept.agentTab !== undefined) restore.agentTab = kept.agentTab;
  }
  const namedKinds = besideKindsOf(named);
  const restored = besideKindsOf(restore);
  const front = namedKinds[0] ?? (kept.front && restored.includes(kept.front) ? kept.front : restored[0]) ?? null;
  return { restore, front };
}

/** Only `kinds` of `state` (a profile with its tab); the front is the state's if it is one of them, else the first. */
export function onlyBesideKinds(state: BesideState | null, kinds: readonly BesideKind[]): BesideState {
  return withoutBesideKinds(state ?? {}, BESIDE_KINDS.filter((kind) => !kinds.includes(kind)));
}

/** `state` without `kinds` (the ones found no longer visible). */
export function withoutBesideKinds(state: BesideState, kinds: readonly BesideKind[]): BesideState {
  const next: BesideState = { ...state };
  for (const kind of kinds) {
    delete next[kind];
    if (kind === "profile") delete next.agentTab;
  }
  return normalizeBeside(next);
}

/** The entries kept: the `max` most recently written. */
export function pruneBesideEntries<T extends { at: number }>(conversations: Record<string, T>, max = BESIDE_MEMORY_MAX_CONVERSATIONS): Record<string, T> {
  const entries = Object.entries(conversations);
  if (entries.length <= max) return conversations;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.at - a.at).slice(0, Math.max(0, max)));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function storageKey(userId: string, serverId: string): string {
  return `${BESIDE_MEMORY_STORAGE_PREFIX}${userId}:${serverId}`;
}

function scoped(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string): string | null {
  if (!userId || !serverId || !ID.test(userId) || !ID.test(serverId) || !ID.test(conversationId)) return null;
  return storageKey(userId, serverId);
}

function readStored(store: Storage, key: string): Stored {
  const empty: Stored = { v: VERSION, conversations: {} };
  const raw = store.getItem(key);
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const { v, conversations } = parsed as { v?: unknown; conversations?: unknown };
  if (v !== VERSION || !conversations || typeof conversations !== "object" || Array.isArray(conversations)) return empty;
  const kept: Record<string, StoredEntry> = {};
  for (const [id, entry] of Object.entries(conversations as Record<string, unknown>)) {
    if (!ID.test(id)) continue;
    const state = normalizeBeside(entry);
    if (isBesideEmpty(state)) continue;
    const at = (entry as { at?: unknown }).at;
    kept[id] = { ...state, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  }
  return { v: VERSION, conversations: kept };
}

/** What was open beside `conversationId` for this person on this server; null for nothing (or nothing readable). */
export function recallBeside(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string): BesideState | null {
  const key = scoped(userId, serverId, conversationId);
  const store = storage();
  if (!key || !store) return null;
  try {
    const entry = readStored(store, key).conversations[conversationId];
    if (!entry) return null;
    const { at: _at, ...state } = entry;
    return state;
  } catch {
    return null;
  }
}

/** Remembers `state` for the conversation (nothing open: forgets it), and keeps the entry within its bound. */
export function rememberBeside(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string, state: BesideState, now: number = Date.now()): void {
  const key = scoped(userId, serverId, conversationId);
  const store = storage();
  if (!key || !store) return;
  try {
    const stored = readStored(store, key);
    const next = normalizeBeside(state);
    if (isBesideEmpty(next)) {
      if (!(conversationId in stored.conversations)) return;
      delete stored.conversations[conversationId];
    } else {
      stored.conversations[conversationId] = { ...next, at: now };
    }
    const conversations = pruneBesideEntries(stored.conversations);
    if (Object.keys(conversations).length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ v: VERSION, conversations } satisfies Stored));
  } catch {
    // Storage full or blocked: nothing is remembered; what is open stays open.
  }
}

/** Sign-out: everything remembered for this person on this device, on every server. */
export function forgetBesideMemory(userId: string | null | undefined): void {
  const store = storage();
  if (!userId || !store) return;
  try {
    const prefix = `${BESIDE_MEMORY_STORAGE_PREFIX}${userId}:`;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

// authStore forgets a person's device data through forgetDrafts (sign-out, the
// session's end, another person signing in on another tab); authStore imports
// this module, so this is registered wherever a session can end.
onDraftsForgotten(forgetBesideMemory);
