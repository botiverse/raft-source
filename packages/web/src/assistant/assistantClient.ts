import type { CapacityLimitDetail } from "@botiverse/raft-shared";
import { ASSISTANT_OWNER_NOTES_MAX_LENGTH } from "@botiverse/raft-shared";
// Client data layer for the personal assistant (RFC 075 v4): the owner-only
// "my assistant" endpoints under /api/servers/:serverId/assistant.
//
//   GET    → { enabled, assistant: null | { id, name, agentId, dmChannelId: string | null } }
//   POST            → 201, same shape   409 assistant_exists (body carries the existing assistant)
//          400 with Create Agent's seat-limit error ("… limit reached (n/m on X plan).")
//          Every assistant is named Ottie with the otter avatar: the server
//          sets both and ignores a `name` (older clients sent one).
//   PATCH  { name } → 400 assistant_name_fixed (the name can't change)
//   DELETE          → 200 { enabled, assistant: null }   404 assistant_not_found
//   403 assistant_not_enabled anywhere.
//
// `dmChannelId` is null until the owner's DM with the assistant exists (it is
// set up right after the agent); the page shows "Setting up your chat…" and
// asks again with backoff (refetchMyAssistant).
//
// `enabled` is false when the flag is off or the hosted runtime is
// unavailable. A server that predates these endpoints answers GET with 404;
// that also reads as not enabled, so this web build can ship before the
// server does.
//
// RFC 077: the owner's own switches ride on the assistant record:
// `assistant.readsDms` and `assistant.sendAsOwner` (the server sets their
// defaults; both on for new assistants);
// PATCH takes `{ readsDms }` or `{ sendAsOwner }`. A switch shows only when its
// boolean is in the response, so a server without it shows none.
// RFC 077: `assistant.ownerNotes` (text or null) is the owner's own extra
// instructions, sent to the assistant after Raft's fixed ones; only the owner
// reads them. PATCH `{ ownerNotes }` saves them (the server trims; empty or
// null clears; over ASSISTANT_OWNER_NOTES_MAX_LENGTH is 400
// invalid_owner_notes) and answers with the saved value. A server without the
// field leaves it out, and the entry is hidden.
//   DELETE /delegated/:messageId → 200 { messageId, deletedAt }: the owner
//   retracts a message their assistant sent as them (404 for anyone else).

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { create } from "zustand";
import axios from "axios";
import api from "../api/client";
import { isCapacityLimitError } from "../utils/capacityLimitError";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import {
  PERSONAL_ASSISTANT_FLAG_KEY,
  useServerFeatureFlag,
} from "../store/serverFeatureFlags";

export type AssistantRecord = {
  /** Equals `agentId` in v4. */
  id: string;
  name: string;
  /** The assistant's agent in this server, the one its owner DMs. */
  agentId: string;
  /** The owner's DM with that agent; null while it is still being set up. */
  dmChannelId: string | null;
};

/**
 * The owner's switches as the server reports them. `null`: the server says
 * nothing (an older server), so the switch isn't shown.
 */
export type AssistantOwnerSettings = {
  /** Whether the assistant reads the owner's DMs. */
  readsDms: boolean | null;
  /** Whether the assistant may send messages as the owner. */
  sendAsOwner: boolean | null;
  /**
   * The owner's extra instructions: `""` when they wrote none, `null` when
   * the server doesn't report them (an older server), so the entry isn't shown.
   */
  ownerNotes: string | null;
};

/** The owner's switches (the booleans in AssistantOwnerSettings). */
export type AssistantOwnerSetting = "readsDms" | "sendAsOwner";

/** The server's limit on the owner's notes (#10762), in UTF-16 code units, after trimming. */
export { ASSISTANT_OWNER_NOTES_MAX_LENGTH };

export type MyAssistantResponse = {
  enabled: boolean;
  assistant: AssistantRecord | null;
  settings: AssistantOwnerSettings;
};

const NO_SETTINGS: AssistantOwnerSettings = Object.freeze({ readsDms: null, sendAsOwner: null, ownerNotes: null });
const NOT_ENABLED: MyAssistantResponse = Object.freeze({ enabled: false, assistant: null, settings: NO_SETTINGS });

/**
 * The server is at its agent or seat limit: the same 400 and message ordinary
 * agent creation returns, shown as Create Agent shows it.
 */
export class AssistantCapacityError extends Error {
  /** The refusal's numbers (Pro seats), so the page can offer to add or ask for them. */
  constructor(message: string, readonly capacityLimit: CapacityLimitDetail | null = null) {
    super(message);
  }
}

type ErrorBody = { code?: string; error?: string; enabled?: boolean; assistant?: AssistantRecord | null; capacityLimit?: CapacityLimitDetail };

function errorOf(error: unknown): { status: number | null; code: string | null; body: ErrorBody | null } {
  if (!axios.isAxiosError(error)) return { status: null, code: null, body: null };
  const body = (error.response?.data ?? null) as ErrorBody | null;
  return {
    status: error.response?.status ?? null,
    code: body?.code ?? body?.error ?? null,
    body,
  };
}

function path(serverId: string): string {
  return `/servers/${serverId}/assistant`;
}

// ---- Cache -------------------------------------------------------------------

type Key = `${string}:${string}`;

const useAssistantCache = create<{ byKey: Record<Key, MyAssistantResponse | undefined> }>(() => ({ byKey: {} }));
const inFlight = new Map<Key, Promise<void>>();

function keyOf(serverId: string, userId: string): Key {
  return `${serverId}:${userId}`;
}

function store(key: Key, response: MyAssistantResponse) {
  useAssistantCache.setState((state) => ({ byKey: { ...state.byKey, [key]: response } }));
}

function currentScope(): { serverId: string; key: Key } {
  const serverId = useServerStore.getState().current?.id;
  const userId = useAuthStore.getState().user?.id;
  if (!serverId || !userId) throw new Error("No current server or user");
  return { serverId, key: keyOf(serverId, userId) };
}

type AssistantBody = {
  enabled?: boolean;
  assistant?: (AssistantRecord & { readsDms?: unknown; sendAsOwner?: unknown; ownerNotes?: unknown }) | null;
};

function ownerSwitch(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Text as saved, `""` for none (null from the server), `null` when the field is missing. */
function ownerNotesOf(raw: { ownerNotes?: unknown }): string | null {
  if (!("ownerNotes" in raw)) return null;
  return typeof raw.ownerNotes === "string" ? raw.ownerNotes : "";
}

function normalize(data: unknown): MyAssistantResponse {
  const body = (data ?? {}) as AssistantBody;
  const raw = body.assistant ?? null;
  return {
    enabled: body.enabled === true,
    assistant: raw ? { id: raw.id, name: raw.name, agentId: raw.agentId, dmChannelId: raw.dmChannelId } : null,
    settings: raw
      ? { readsDms: ownerSwitch(raw.readsDms), sendAsOwner: ownerSwitch(raw.sendAsOwner), ownerNotes: ownerNotesOf(raw) }
      : NO_SETTINGS,
  };
}

async function fetchInto(serverId: string, key: Key, keepOnError = false): Promise<void> {
  try {
    const { data } = await api.get(path(serverId));
    store(key, normalize(data));
  } catch (error) {
    const { status } = errorOf(error);
    // A refetch keeps what it had on a transient failure rather than closing the page.
    if (keepOnError && status !== 403 && status !== 404) return;
    // 403 assistant_not_enabled, or 404 from a server without the endpoints:
    // not available here. Anything else (offline, 5xx) also fails closed.
    if (status !== null && status !== 403 && status !== 404) {
      console.warn("[assistant] failed to load my assistant", { status });
    }
    store(key, NOT_ENABLED);
  }
}

function load(serverId: string, key: Key, keepOnError = false): Promise<void> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchInto(serverId, key, keepOnError).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Reload after a 404 assistant_not_found or a state the client can't trust. */
function refresh(): Promise<void> {
  const { serverId, key } = currentScope();
  return load(serverId, key);
}

/** Shared handling of the errors every mutation can return. */
async function handleMutationError(error: unknown, key: Key): Promise<void> {
  const { status, code, body } = errorOf(error);
  if (status === 400 && typeof body?.error === "string" && isCapacityLimitError(body.error)) {
    throw new AssistantCapacityError(body.error, body.capacityLimit ?? null);
  }
  if (status === 403) {
    // assistant_not_enabled: the page closes and redirects.
    store(key, NOT_ENABLED);
    return;
  }
  if (status === 409 && code === "assistant_exists" && body?.assistant) {
    // Adopt the existing assistant and open its DM.
    store(key, { ...normalize(body), enabled: true });
    return;
  }
  if (status === 404 || status === 409) {
    await refresh();
    return;
  }
  throw error;
}

// ---- Public API --------------------------------------------------------------

export type MyAssistantState =
  | { status: "loading" }
  /** Not available here: the flag is off, the API says not enabled, or a guest. */
  | { status: "off" }
  | { status: "ready"; assistant: AssistantRecord | null; settings: AssistantOwnerSettings };

/**
 * The current person's assistant in the current server. Asks only when the
 * server's `personal_assistant` flag is on (the flag is a pre-check that skips
 * the request); then `enabled` from the response decides. Guests never ask:
 * the endpoints are owner-only and v0 has no assistant for guests.
 */
export function useMyAssistant({ ask = true }: {
  /** False: read what is known, ask the server nothing (a frame whose server is still loading). */
  ask?: boolean;
} = {}): MyAssistantState {
  const flag = useServerFeatureFlag(PERSONAL_ASSISTANT_FLAG_KEY, { prefetch: ask });
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const isGuest = useServerStore((s) => s.current?.role === "guest");
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const shouldAsk = ask && flag.state === "enabled" && !isGuest && !!serverId && !!userId;
  const key = serverId && userId ? keyOf(serverId, userId) : null;
  const cached = useAssistantCache((s) => (key ? s.byKey[key] : undefined));
  const loaded = cached !== undefined;

  useEffect(() => {
    if (!shouldAsk || loaded || !key || !serverId) return;
    void load(serverId, key);
  }, [shouldAsk, loaded, key, serverId]);

  if (isGuest) return { status: "off" };
  if (flag.state === "loading") return { status: "loading" };
  if (flag.state !== "enabled") return { status: "off" };
  if (!cached) return { status: "loading" };
  if (!cached.enabled) return { status: "off" };
  return { status: "ready", assistant: cached.assistant, settings: cached.settings };
}

/**
 * One UI per assistant (Tenny, #17 item 2): the viewer's own assistant's DM
 * is the assistant page, so `/dm/<that DM>` goes there instead (a sidebar
 * row, a link, a typed URL). The query and hash go along: the page's DM is
 * the same ChatPanel, which reads `msg` (scroll to and highlight a message)
 * and `thread` from the URL as the DM route did. Null for every other DM,
 * and while the assistant is still answering.
 */
export function useOwnAssistantPageForDm(dmId: string | undefined): string | null {
  const mine = useMyAssistant();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const { search, hash } = useLocation();
  if (!dmId || !serverSlug || mine.status !== "ready" || mine.assistant?.dmChannelId !== dmId) return null;
  return `/s/${serverSlug}/assistant${search}${hash}`;
}

/**
 * The viewer's own assistant's DM, as far as already known (asks the server
 * nothing): that DM's route is the assistant page (useOwnAssistantPageForDm),
 * so it is no place for the Chat tab to go back to (useTabRouteMemory).
 * Undefined while that is not known yet; null: none.
 */
export function useOwnAssistantDmId(): string | null | undefined {
  const mine = useMyAssistant({ ask: false });
  if (mine.status === "loading") return undefined;
  return mine.status === "ready" ? (mine.assistant?.dmChannelId ?? null) : null;
}

/**
 * GET again while the assistant's DM is being set up. Unlike the first load, a
 * transient failure keeps the cached answer.
 */
export function refetchMyAssistant(): Promise<void> {
  const { serverId, key } = currentScope();
  return load(serverId, key, true);
}

const DM_SETUP_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];
let dmSetupRetryDelaysMs = DM_SETUP_RETRY_DELAYS_MS;

/** How long to wait before each refetch while `dmChannelId` is null. */
export function getDmSetupRetryDelaysMs(): readonly number[] {
  return dmSetupRetryDelaysMs;
}

export function setDmSetupRetryDelaysForTests(delays: readonly number[]): void {
  dmSetupRetryDelaysMs = delays;
}

/** POST. Throws AssistantCapacityError at the agent or seat limit. */
export async function createAssistant(): Promise<void> {
  const { serverId, key } = currentScope();
  try {
    const { data } = await api.post(path(serverId), {});
    store(key, normalize(data));
  } catch (error) {
    await handleMutationError(error, key);
  }
}

/** DELETE. Deletes the assistant's agent; the page returns to Create. */
export async function deleteAssistant(): Promise<void> {
  const { serverId, key } = currentScope();
  try {
    const { data } = await api.delete(path(serverId));
    store(key, normalize(data));
  } catch (error) {
    await handleMutationError(error, key);
  }
}

/** One owner switch could not be saved; it is back where it was. */
export class AssistantSettingSaveError extends Error {
  constructor() {
    super("assistant_setting_save_failed");
  }
}

function patchSetting(key: Key, setting: AssistantOwnerSetting, value: boolean | null) {
  const current = useAssistantCache.getState().byKey[key];
  if (!current) return;
  store(key, { ...current, settings: { ...current.settings, [setting]: value } });
}

/**
 * PATCH { readsDms } or { sendAsOwner }, optimistically: the switch moves at
 * once and moves back when the save fails (AssistantSettingSaveError). A 403
 * or 404 means the server no longer lets this person change it: the cache
 * refetches, which hides the switch or closes the page as the server now says.
 */
export async function updateAssistantSetting(setting: AssistantOwnerSetting, value: boolean): Promise<void> {
  const { serverId, key } = currentScope();
  const previous = useAssistantCache.getState().byKey[key]?.settings[setting] ?? null;
  patchSetting(key, setting, value);
  try {
    const { data } = await api.patch(path(serverId), { [setting]: value });
    // Take only this switch from the answer: the other one may have a save of
    // its own in flight, and this response predates it.
    const saved = normalize(data).settings[setting];
    patchSetting(key, setting, saved ?? value);
  } catch (error) {
    patchSetting(key, setting, previous);
    const { status } = errorOf(error);
    if (status === 403 || status === 404) void refresh();
    throw new AssistantSettingSaveError();
  }
}

/** The server refused the notes as too long (400 invalid_owner_notes). */
export class AssistantOwnerNotesTooLongError extends Error {
  constructor() {
    super("invalid_owner_notes");
  }
}

/** The notes could not be saved for any other reason; nothing changed. */
export class AssistantOwnerNotesSaveError extends Error {
  constructor() {
    super("assistant_owner_notes_save_failed");
  }
}

/**
 * PATCH { ownerNotes }: the owner's extra instructions, trimmed; empty clears
 * them. Not optimistic: the dialog stays open with the draft until the server
 * answers, then the cache takes the saved value. Throws
 * AssistantOwnerNotesTooLongError on 400 invalid_owner_notes and
 * AssistantOwnerNotesSaveError on anything else; a 403 or 404 also refetches,
 * which closes the page or returns to Create as the server now says.
 */
export async function saveAssistantOwnerNotes(notes: string): Promise<void> {
  const { serverId, key } = currentScope();
  const trimmed = notes.trim();
  try {
    const { data } = await api.patch(path(serverId), { ownerNotes: trimmed || null });
    const current = useAssistantCache.getState().byKey[key];
    if (!current) return;
    // Take only the notes from the answer, as a switch save does.
    const saved = normalize(data).settings.ownerNotes;
    store(key, { ...current, settings: { ...current.settings, ownerNotes: saved ?? trimmed } });
  } catch (error) {
    const { status, code } = errorOf(error);
    if (status === 400 && code === "invalid_owner_notes") throw new AssistantOwnerNotesTooLongError();
    if (status === 403 || status === 404) void refresh();
    throw new AssistantOwnerNotesSaveError();
  }
}

/**
 * RFC 077: the owner retracts a message their assistant sent as them. Author
 * only (anyone else gets a uniform 404), idempotent, and it works after the
 * assistant was deleted, so it needs no assistant cache. Resolves with the
 * server's `deletedAt`; the message and its receipt also update through
 * `message:updated`. Throws on any failure.
 */
export async function retractDelegatedMessage(messageId: string): Promise<{ deletedAt: string }> {
  const serverId = useServerStore.getState().current?.id;
  if (!serverId) throw new Error("No current server");
  const { data } = await api.delete(`${path(serverId)}/delegated/${encodeURIComponent(messageId)}`);
  const deletedAt = (data as { deletedAt?: unknown } | undefined)?.deletedAt;
  return { deletedAt: typeof deletedAt === "string" ? deletedAt : new Date().toISOString() };
}

/** Clears the cache. Tests and session changes. */
export function resetAssistantClientForTests(): void {
  inFlight.clear();
  useAssistantCache.setState({ byKey: {} });
  dmSetupRetryDelaysMs = DM_SETUP_RETRY_DELAYS_MS;
}
