import { createIntl, createIntlCache } from "react-intl";
import type { IntlShape } from "react-intl";
import type { Socket } from "socket.io-client";
import { z } from "zod";
import { create } from "zustand";
import { toast } from "@botiverse/raft-ui";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { LINK_CARD_OPERATION_CHANGED_EVENT, linkCardToastSchema } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardElement } from "@botiverse/raft-shared/src/appLinkPreview";
import api from "../../api/client";
import { getSocket, onSocketCreated } from "../../api/socket";
import { DEFAULT_LOCALE } from "../../i18n/locale";
import { shownLocaleMessages } from "../../i18n/messages";
import type { MessageId } from "../../i18n/messages";
import { useAuthStore } from "../../store/authStore";
import { linkPreviewViewerKey } from "../../store/linkPreviewConsentStore";
import { useServerStore } from "../../store/serverStore";
import { LinkCardUndoCountdown } from "./LinkCardUndoCountdown";
import type { AppLinkResult, LinkCardActionHandle } from "./useAppLinkPreviews";

// The hover card's buttons (protocol v3.2.3 §4.4, §5.2-§5.4, §7, §8.2-§8.3;
// addendum 5 §3; RFC 076 §6.2-§6.4, §6.8). docs/development/app-link-previews.md,
// "Web display".
//
// Everything a button starts belongs to its view, "this link in this message"
// (`viewKey`: viewer, Server, message, URL), never to the hover card: the card
// can close, the message can scroll away and come back, and the state is here.
// - read: the link is read again with its ticket (useAppLinkPreviews).
// - execute with `confirm: "prepare"`: Raft asks the App for a description and
//   shows it in its own modal dialog (LinkCardActions.tsx), outside the hover
//   card; confirming executes with the prepared id and digest.
// - execute with `undoWindowMs`: a toast counts the window down with Undo. Undo
//   sends nothing; when the window ends, execute is sent once, whatever the
//   hover card does meanwhile.
// - execute moves the message view's request count on (protocol §7.1); the
//   view shows the pending state until the read after the answer returns, and
//   while the operation it started is open. Its `client_request_id` is kept in
//   a small local record per viewer and Server (`slock:link-card-operations:*`)
//   with the operation id once known. An answer that doesn't come (no answer,
//   5xx, LOCK_TIMEOUT) is asked for again with the same id, which Raft answers
//   from its records (§5.3.2 step 2); a reload recovers the operation by status,
//   or by the request id when only that was kept (§7.4).
// - status is read at 2 s, 5 s, 15 s, 60 s, then every 5 minutes while the
//   message is mounted and the operation open, and whenever a
//   `link_card.operation_changed` hint names it. A toast shows at most once
//   per receipt revision: the App's own toast only when status returns it
//   (`app_result`), else Raft's fixed hint for a new state. A terminal receipt
//   reads the card again if the message is still shown.

type Format = IntlShape["formatMessage"];
type CardResult = Extract<AppLinkResult, { kind: "card" }>;
export type LinkCardButton = Extract<LinkCardElement, { type: "Button" }>["props"];
type ExecuteAction = Extract<LinkCardButton["action"], { kind: "execute" }>;

/**
 * What reading one link again gave: its fresh result (null: the author's link
 * now), or nothing usable. `unshown`: the message has no answer on screen yet,
 * so nothing was asked (its first read comes once it is in view).
 */
export type LinkCardReread = { kind: "read"; result: AppLinkResult | null } | { kind: "superseded" } | { kind: "failed" } | { kind: "unshown" };

/**
 * A mounted message as its buttons see it (useAppLinkPreviews): read one link
 * again with its ticket, or move the view's request count on as an execute is
 * sent. `key` is `<viewer>:<server>|<messageId>`.
 */
export type LinkCardMessageView = {
  key: string;
  messageId: string;
  reread(url: string): Promise<LinkCardReread>;
  beginExecute(): void;
};

const OPERATION_STATES = ["sent", "accepted", "done", "refused", "failed_not_sent", "unknown", "needs_reconciliation", "resolved_manually"] as const;
export type LinkCardOperationState = typeof OPERATION_STATES[number];
const TERMINAL: ReadonlySet<string> = new Set(["done", "refused", "failed_not_sent", "resolved_manually"]);

/** A handle older than this (client clock) is read again before it is used; Raft signs them for at most 10 minutes. */
export const LINK_CARD_HANDLE_FRESH_MS = 9 * 60_000;
/** The status cadence (RFC 076 §6.4): these steps, then every 5 minutes, for 24 hours. */
const STATUS_STEPS_MS = [2000, 5000, 15_000, 60_000];
const STATUS_EVERY_MS = 5 * 60_000;
const STATUS_FOR_MS = 24 * 3600_000;
/**
 * An execute whose answer doesn't come is sent again with the same
 * `client_request_id` after these waits (a 429's `retry_after` instead, when
 * it gives one); after the last, its request id is looked up.
 */
export const LINK_CARD_EXECUTE_RETRY_MS = [1000, 2000, 4000];
/**
 * A request-id record younger than this may still be on its way from another
 * tab, so recovery that finds nothing for it yet leaves it alone. It covers
 * an execute's usual course (four requests, 7 s of waits between them), not
 * every one: a 429 waits its `retry_after` (up to 60 s) before each resend,
 * and a request has no deadline of its own, so an older record can still be
 * in flight. Deleting it then costs only reload recovery: the tab sending it
 * follows its answer in memory.
 */
export const LINK_CARD_REQUEST_SETTLE_MS = 30_000;
/** After a request-id lookup failed, a remount (timeline scrolling) asks again only after this. In memory. */
export const LINK_CARD_LOOKUP_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Answers, read as this client needs them (unknown fields are ignored).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID);
const codePoints = (min: number, max: number) => z.string().refine((value) => {
  const length = [...value].length;
  return length >= min && length <= max;
});
/**
 * The description fields Raft's dialog shows (protocol §5.2), as plain text.
 * Raft already validated the whole description; the ids, `terms`, `target`
 * and the rest are dropped here and never drawn.
 */
const descriptionSchema = z.object({
  title: codePoints(1, 120),
  body: codePoints(0, 500).optional(),
  fine_print: codePoints(0, 500).optional(),
  rows: z.array(z.object({ label: codePoints(1, 40), value: codePoints(1, 200) })).max(8).optional(),
  confirm_label: codePoints(1, 40),
  cancel_label: codePoints(1, 40),
});
export type LinkCardDescription = z.infer<typeof descriptionSchema>;
const prepareAnswerSchema = z.union([
  z.object({ prepared_action_id: uuid, prepared_digest: z.string().regex(/^[0-9a-f]{64}$/), description: descriptionSchema }),
  z.object({ status: z.literal("refused") }),
]);
const executeAnswerSchema = z.union([
  z.object({ operation_id: uuid, state: z.enum(OPERATION_STATES) }),
  z.object({ state: z.literal("not_visible") }),
]);
const receiptSchema = z.object({
  operation_id: uuid,
  state: z.enum(OPERATION_STATES),
  receipt_revision: z.number().int().min(0),
  // The App's private result: present only when both of Raft's gates passed in this status.
  app_result: z.object({ toast: linkCardToastSchema.optional() }).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
const statusAnswerSchema = z.union([receiptSchema, z.object({ operation_id: uuid, state: z.literal("not_visible") })]);
const operationChangedSchema = z.object({ operation_id: uuid, receipt_revision: z.number().int().min(0) });

const httpStatus = (error: unknown): number | undefined => {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
};
const errorBody = (error: unknown): Record<string, unknown> => {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
};
/** Seconds to wait from a 429: `retry_after`, else `Retry-After`; 1-3600. */
function retryAfterSeconds(error: unknown): number {
  const fromBody = Number(errorBody(error).retry_after);
  const header = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers?.["retry-after"];
  const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 1;
}
/**
 * Whether an execute's answer was lost, so the same request goes again: no
 * answer, a server failure, or LOCK_TIMEOUT ("try again with the same
 * request", protocol §5.1). On a repeat, RATE_LIMITED may be Raft's recovery
 * budget, so that one waits and goes again too. Anything else is an answer.
 */
function answerLost(error: unknown, repeat: boolean): boolean {
  const status = httpStatus(error);
  if (status === undefined || status >= 500) return true;
  const code = errorBody(error).code;
  return status === 429 && (code === "LOCK_TIMEOUT" || (repeat && code === "RATE_LIMITED"));
}
const wait = (ms: number) => new Promise<void>((resolve) => { setClockTimeout(resolve, ms); });

/**
 * The UI's language for the App calls behind prepare, execute and status: Raft
 * reads it from Accept-Language (protocol §5.0), and the browser's own may be
 * another. The `<html lang>` LocaleProvider sets.
 */
function languageHeaders(): { headers: Record<string, string> } | undefined {
  const lang = globalThis.document?.documentElement.lang;
  return lang ? { headers: { "Accept-Language": lang } } : undefined;
}

/** hex(SHA-256(UTF-8(href))) (protocol §11); null where the browser has no WebCrypto. */
export async function linkCardUrlSha256(url: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(url));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local records: the operations this browser started, per viewer and Server
// (localStorage, like utils/computerAttentionSeen.ts). Bounded (50, 48 hours)
// and best-effort; the server stays the source of truth. No URL or App text
// is kept: ids, the URL's digest, and which receipt was last shown.

const RECORDS_PREFIX = "slock:link-card-operations";
const RECORDS_MAX = 50;
const RECORD_TTL_MS = 48 * 3600_000;
const recordSchema = z.object({
  message_id: z.string().min(1).max(200),
  url_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  client_request_id: z.string().min(1).max(128).optional(),
  operation_id: uuid.optional(),
  at: z.number(),
  toasted_revision: z.number().int().optional(),
  toasted_state: z.string().max(40).optional(),
}).refine((record) => !!record.client_request_id || !!record.operation_id);
export type LinkCardOperationRecord = z.infer<typeof recordSchema>;

const recordsKey = (viewerKey: string) => `${RECORDS_PREFIX}:${viewerKey}`;
export function readLinkCardOperationRecords(viewerKey: string): LinkCardOperationRecord[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(recordsKey(viewerKey)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const now = currentTimeMs();
    return parsed.flatMap((raw) => {
      const record = recordSchema.safeParse(raw);
      return record.success && now - record.data.at < RECORD_TTL_MS ? [record.data] : [];
    });
  } catch {
    return [];
  }
}
function writeRecords(viewerKey: string, records: LinkCardOperationRecord[]) {
  try {
    if (!records.length) globalThis.localStorage?.removeItem(recordsKey(viewerKey));
    else globalThis.localStorage?.setItem(recordsKey(viewerKey), JSON.stringify(records.slice(-RECORDS_MAX)));
  } catch {
    // Best effort: the server keeps the operation; this only speeds up recovery.
  }
}
type RecordMatch = { clientRequestId?: string; operationId?: string };
const matches = (record: LinkCardOperationRecord, match: RecordMatch) =>
  (!!match.clientRequestId && record.client_request_id === match.clientRequestId) || (!!match.operationId && record.operation_id === match.operationId);
function putRecord(viewerKey: string, record: LinkCardOperationRecord) {
  const records = readLinkCardOperationRecords(viewerKey).filter((existing) => !matches(existing, { clientRequestId: record.client_request_id, operationId: record.operation_id }));
  writeRecords(viewerKey, [...records, record]);
}
function patchRecord(viewerKey: string, match: RecordMatch, patch: Partial<LinkCardOperationRecord>) {
  writeRecords(viewerKey, readLinkCardOperationRecords(viewerKey).map((record) => (matches(record, match) ? { ...record, ...patch } : record)));
}
function forgetRecord(viewerKey: string, match: RecordMatch) {
  const records = readLinkCardOperationRecords(viewerKey);
  const kept = records.filter((record) => !matches(record, match));
  if (kept.length !== records.length) writeRecords(viewerKey, kept);
}
const findRecord = (viewerKey: string, match: RecordMatch) => readLinkCardOperationRecords(viewerKey).find((record) => matches(record, match));

// ---------------------------------------------------------------------------
// Per-view state, shared by every chip of the view (a link written twice) and
// kept while the hover card is closed.

export type LinkCardConfirm = {
  /** The chip that asked: it draws the dialog and gives focus back. */
  owner: string;
  handle: string;
  prepared: { id: string; digest: string };
  description: LinkCardDescription;
  /** Confirmed: execute is on its way and the dialog waits for its answer. */
  executing: boolean;
};
/**
 * What `actionId` holds while a read button reads. Not a possible action_id
 * (`^[a-z][a-z0-9_]*$` has no ":"), so an execute named `read` never looks busy
 * when Refresh is, nor the other way round.
 */
export const READ_BUSY_KEY = ":read";

export type LinkCardViewState = {
  /**
   * What the view is doing; its read and execute buttons are disabled
   * meanwhile. `recovering`: a request whose answer never came is looked up.
   */
  busy?: "reading" | "preparing" | "confirming" | "holding" | "executing" | "recovering" | "refreshing";
  /** The button that started `busy`: its action_id, or READ_BUSY_KEY for a read button. */
  actionId?: string;
  /** An operation of this viewer on this link that is not finished. */
  operation?: { id: string; state: LinkCardOperationState };
  confirm?: LinkCardConfirm;
};
type ActionStore = {
  views: Record<string, LinkCardViewState>;
  /** Viewers (`<viewer>:<server>`) whose Server answered 404: the flag is off, buttons are hidden. */
  unavailable: Record<string, true>;
};
export const useLinkCardActionStore = create<ActionStore>(() => ({ views: {}, unavailable: {} }));
const NO_VIEW_STATE: LinkCardViewState = Object.freeze({});

export const linkCardViewKey = (view: LinkCardMessageView, url: string) => `${view.key}|${url}`;
const viewerKeyOf = (messageKey: string) => messageKey.slice(0, messageKey.indexOf("|"));
const viewState = (viewKey: string) => useLinkCardActionStore.getState().views[viewKey] ?? NO_VIEW_STATE;
function setViewState(viewKey: string, next: LinkCardViewState | ((current: LinkCardViewState) => LinkCardViewState)) {
  useLinkCardActionStore.setState((store) => {
    const current = store.views[viewKey] ?? NO_VIEW_STATE;
    const value = typeof next === "function" ? next(current) : next;
    const views = { ...store.views };
    if (!value.busy && !value.operation && !value.confirm) delete views[viewKey];
    else views[viewKey] = value;
    return { views };
  });
}
const setBusy = (viewKey: string, busy: LinkCardViewState["busy"], actionId?: string) =>
  setViewState(viewKey, (current) => ({ operation: current.operation, confirm: busy === "confirming" || busy === "executing" ? current.confirm : undefined, busy, actionId }));
const clearBusy = (viewKey: string) => setViewState(viewKey, (current) => ({ operation: current.operation }));
const setOperation = (viewKey: string, operation: LinkCardViewState["operation"]) => setViewState(viewKey, (current) => ({ ...current, operation }));

/** The view's state for a component. */
export function useLinkCardViewState(viewKey: string | null): LinkCardViewState {
  return useLinkCardActionStore((store) => (viewKey ? store.views[viewKey] : undefined) ?? NO_VIEW_STATE);
}
export function useLinkCardActionsUnavailable(view: LinkCardMessageView | undefined): boolean {
  return useLinkCardActionStore((store) => !!view && !!store.unavailable[viewerKeyOf(view.key)]);
}

// ---------------------------------------------------------------------------
// Words. A press brings the component's formatter; background work (status,
// hints) uses the latest one a mounted message gave, else the shown locale's.

const fallbackIntlCache = createIntlCache();
function fallbackFormat(): Format {
  const { locale, messages } = shownLocaleMessages();
  return createIntl({ locale, defaultLocale: DEFAULT_LOCALE, messages }, fallbackIntlCache).formatMessage;
}
let latestFormat: Format | null = null;
function backgroundFormat(): Format {
  for (const set of [...registrations.values()].reverse()) {
    for (const registration of set) {
      const format = registration.format?.();
      if (format) return format;
    }
  }
  return latestFormat ?? fallbackFormat();
}

/** Raft's fixed hint per state, localized (the server's English text is the same copy). */
const STATE_HINTS: Record<LinkCardOperationState, { id: MessageId; tone: "info" | "success" | "warning" }> = {
  sent: { id: "message.appLink.action.state.sent", tone: "info" },
  accepted: { id: "message.appLink.action.state.accepted", tone: "info" },
  done: { id: "message.appLink.action.state.done", tone: "success" },
  refused: { id: "message.appLink.action.state.notCarriedOut", tone: "warning" },
  failed_not_sent: { id: "message.appLink.action.state.notCarriedOut", tone: "warning" },
  unknown: { id: "message.appLink.action.state.unconfirmed", tone: "warning" },
  needs_reconciliation: { id: "message.appLink.action.state.unconfirmed", tone: "warning" },
  resolved_manually: { id: "message.appLink.action.state.resolvedManually", tone: "info" },
};
function showToast(tone: "info" | "success" | "warning", text: string) {
  if (tone === "success") toast.success(text);
  else if (tone === "warning") toast.warning(text);
  else toast.info(text);
}
const showStateHint = (format: Format, state: LinkCardOperationState) => showToast(STATE_HINTS[state].tone, format({ id: STATE_HINTS[state].id }));
const showWarning = (format: Format, id: MessageId, values?: Record<string, string | number>) => showToast("warning", format({ id }, values));

// ---------------------------------------------------------------------------
// Mounted messages.

type Registration = {
  viewerKey: string; messageId: string; view: LinkCardMessageView; urls: string[]; hashes: Map<string, string> | null;
  /** The UI's formatter where the message is mounted, for toasts no press asked for (status, hints). */
  format?: () => Format | null;
};
const registrations = new Map<string, Set<Registration>>();

const mountedView = (messageKey: string): LinkCardMessageView | null => [...registrations.get(messageKey) ?? []].at(-1)?.view ?? null;
function urlForHash(messageKey: string, urlSha256: string): string | null {
  for (const registration of registrations.get(messageKey) ?? []) {
    const url = registration.hashes?.get(urlSha256);
    if (url) return url;
  }
  return null;
}

/**
 * A message with App links is mounted with the batched read on: its operations
 * are recovered from the local records and followed while it stays mounted.
 * Returns the unregister.
 */
export function registerLinkCardMessageView(input: { viewerKey: string; messageId: string; urls: string[]; view: LinkCardMessageView; format?: () => Format | null }): () => void {
  const registration: Registration = { ...input, hashes: null };
  const messageKey = input.view.key;
  const set = registrations.get(messageKey) ?? new Set();
  set.add(registration);
  registrations.set(messageKey, set);
  listenForHints();
  void hashesOf(registration).then(() => {
    if (registrations.get(messageKey)?.has(registration)) void recover(registration);
  });
  return () => {
    const current = registrations.get(messageKey);
    current?.delete(registration);
    if (current?.size) return;
    registrations.delete(messageKey);
    // Status is read only while the message is mounted.
    for (const [operationId, poller] of pollers) if (poller.messageKey === messageKey) stopPolling(operationId);
  };
}

/** The digests of a registration's links (protocol §11), which the local records and the lookups name them by. */
async function hashesOf(registration: Registration): Promise<Map<string, string>> {
  if (registration.hashes) return registration.hashes;
  const pairs = await Promise.all(registration.urls.map(async (url) => [await linkCardUrlSha256(url), url] as const));
  registration.hashes = new Map(pairs.flatMap(([hash, url]) => (hash ? [[hash, url] as const] : [])));
  return registration.hashes;
}

/**
 * Recovery on mount (protocol §7.4): an operation this tab follows for the
 * message, or whose id this browser kept, is read by status at once; a
 * request whose answer never came (only its client_request_id was kept) is
 * looked up by that id. Either way the view is pending meanwhile. This tab's
 * own follows come first: their record may be gone (another tab saw the
 * operation finish and deleted it while this message was unmounted and its
 * hint missed), and the view still shows them pending (Remy). A request
 * younger than LINK_CARD_REQUEST_SETTLE_MS may still be on its way from
 * another tab, so finding nothing for it yet deletes nothing; one whose
 * lookup just failed waits LINK_CARD_LOOKUP_COOLDOWN_MS before the next mount
 * asks again.
 */
async function recover(registration: Registration) {
  const { viewerKey, messageId, view } = registration;
  for (const [operationId, known] of followed) {
    if (known.messageKey !== view.key || pollers.has(operationId)) continue;
    // follow() keeps the operation's own start: its cadence and 24 h go on from there.
    follow(operationId, { viewerKey: known.viewerKey, messageKey: view.key, viewKey: known.viewKey, url: known.url }, {
      state: viewState(known.viewKey).operation?.state ?? "sent", at: currentTimeMs(), now: true, shown: known.shown,
    });
  }
  for (const record of readLinkCardOperationRecords(viewerKey)) {
    if (record.message_id !== messageId) continue;
    const url = registration.hashes?.get(record.url_sha256);
    if (!url) continue;
    const viewKey = linkCardViewKey(view, url);
    if (record.operation_id) {
      if (pollers.has(record.operation_id)) continue;
      // Pending until status says otherwise.
      follow(record.operation_id, { viewerKey, messageKey: view.key, viewKey, url }, {
        state: viewState(viewKey).operation?.state ?? "sent", at: record.at, now: true,
        shown: { revision: record.toasted_revision ?? 0, state: record.toasted_state },
      });
    } else if (record.client_request_id && !viewState(viewKey).busy) {
      const clientRequestId = record.client_request_id;
      const failedAt = lookupFailedAt.get(clientRequestId);
      if (failedAt !== undefined && currentTimeMs() - failedAt < LINK_CARD_LOOKUP_COOLDOWN_MS) continue;
      setBusy(viewKey, "recovering");
      const found = await lookupClientRequest(clientRequestId);
      if (found.kind === "failed") lookupFailedAt.set(clientRequestId, currentTimeMs());
      else lookupFailedAt.delete(clientRequestId);
      const young = currentTimeMs() - record.at < LINK_CARD_REQUEST_SETTLE_MS;
      // Only its words if it is finished: an open one shows as pending.
      if (found.kind === "failed" || (found.kind === "none" && young)) clearBusy(viewKey);
      else followRequest({ viewerKey, viewKey, view, url }, clientRequestId, found, "terminal");
    }
  }
}

/** When each request id's lookup last failed, for LINK_CARD_LOOKUP_COOLDOWN_MS. */
const lookupFailedAt = new Map<string, number>();

type RequestLookup = { kind: "found"; receipt: Receipt } | { kind: "not_visible" } | { kind: "none" } | { kind: "failed" };

/**
 * `GET /link-cards/operations?client_request_id=` (C2c): what a request whose
 * answer never came turned into, in any state, without calling the App.
 */
async function lookupClientRequest(clientRequestId: string): Promise<RequestLookup> {
  let data: unknown;
  try {
    ({ data } = await api.get("/link-cards/operations", { params: { client_request_id: clientRequestId } }));
  } catch {
    return { kind: "failed" };
  }
  const operations = (data as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) return { kind: "failed" };
  for (const raw of operations) {
    const receipt = receiptSchema.safeParse(raw);
    if (receipt.success) return { kind: "found", receipt: receipt.data };
  }
  return operations.length ? { kind: "not_visible" } : { kind: "none" };
}

/**
 * A request's operation, found by its id: followed while open, closed (the
 * card read again) when finished. `toast`: which state's hint to show,
 * "any" right after a press, "terminal" on recovery (an open one shows as
 * pending). Nothing: the request never became an operation, so nothing ran.
 */
function followRequest(context: Pick<PressContext, "viewerKey" | "viewKey" | "view" | "url">, clientRequestId: string, found: Exclude<RequestLookup, { kind: "failed" }>, toast: "any" | "terminal", format?: Format) {
  const { viewerKey, viewKey, view, url } = context;
  if (found.kind !== "found") {
    forgetRecord(viewerKey, { clientRequestId });
    if (found.kind === "none") { clearBusy(viewKey); return; }
    // The viewer may not read it now: the card is read again under their access.
    void refresh(viewKey, view.key, url);
    return;
  }
  const { operation_id: operationId, state, receipt_revision: revision } = found.receipt;
  if (toast === "any" || TERMINAL.has(state)) showStateHint(format ?? backgroundFormat(), state);
  if (TERMINAL.has(state)) {
    forgetRecord(viewerKey, { clientRequestId });
    void refresh(viewKey, view.key, url);
    return;
  }
  patchRecord(viewerKey, { clientRequestId }, { operation_id: operationId, toasted_revision: revision, toasted_state: state });
  setViewState(viewKey, (current) => ({ ...current, busy: undefined, actionId: undefined }));
  follow(operationId, { viewerKey, messageKey: view.key, viewKey, url }, {
    state, at: findRecord(viewerKey, { operationId })?.at ?? currentTimeMs(), now: false, shown: { revision, state },
  });
  void refresh(viewKey, view.key, url);
}

/**
 * `GET /link-cards/operations?message_id&url_sha256` (C2c): the viewer's open
 * operations on this link, for a view Raft says is pending (409 VIEW_PENDING:
 * an earlier operation of this view that this client lost track of). The
 * newest becomes the view's pending operation; its receipt so far is not
 * toasted again. One page: a viewer has at most 20 open operations.
 */
async function recoverByUrl(input: { viewerKey: string; view: LinkCardMessageView; url: string }): Promise<boolean> {
  const urlSha256 = await linkCardUrlSha256(input.url);
  if (!urlSha256) return false;
  let data: unknown;
  try {
    ({ data } = await api.get("/link-cards/operations", { params: { message_id: input.view.messageId, url_sha256: urlSha256 } }));
  } catch {
    return false;
  }
  const operations = (data as { operations?: unknown } | null)?.operations;
  const open = (Array.isArray(operations) ? operations : []).flatMap((raw) => {
    const receipt = receiptSchema.safeParse(raw);
    return receipt.success && !TERMINAL.has(receipt.data.state) ? [receipt.data] : [];
  });
  const newest = open.at(-1);
  if (!newest) return false;
  const known = findRecord(input.viewerKey, { operationId: newest.operation_id });
  const at = known?.at ?? currentTimeMs();
  const revision = Math.max(known?.toasted_revision ?? 0, newest.receipt_revision);
  putRecord(input.viewerKey, { message_id: input.view.messageId, url_sha256: urlSha256, operation_id: newest.operation_id, at, toasted_revision: revision, toasted_state: newest.state });
  follow(newest.operation_id, { viewerKey: input.viewerKey, messageKey: input.view.key, viewKey: linkCardViewKey(input.view, input.url), url: input.url }, {
    state: newest.state, at, now: false, shown: { revision, state: newest.state },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Following operations: status polling, receipts and hints.
//
// What this tab follows is its own (`followed`): the view an operation belongs
// to, when it started and the receipt revision this tab last showed. The
// local record is shared by every tab of the browser and another one may
// delete it (it saw the operation finish first), so it only keeps a reload
// from repeating a toast and from losing the operation; it never decides
// whether this tab's view is pending.
//
// A follow outlives its message's mount (the message scrolls away: polling
// stops, the view stays pending), so a remount reads status at once instead
// of trusting the record alone. It ends with the operation's polling for
// good: the operation finished or isn't the viewer's to read (closeOperation),
// or its STATUS_FOR_MS ran out (at its next poll, or, for a message that
// never came back, when this tab follows another operation). Either way the
// view's pending state ends and, if the message is shown, its card is read
// again, so the card shows where the operation got to (Remy).

type FollowTarget = { viewerKey: string; messageKey: string; viewKey: string; url: string };
type Follow = FollowTarget & { at: number; shown: { revision: number; state?: string } };
const followed = new Map<string, Follow>();

/** This tab follows `operationId` for a view: pending there, and its status polled while the message is mounted. */
function follow(operationId: string, target: FollowTarget, input: { state: LinkCardOperationState; at: number; now: boolean; shown: Follow["shown"] }) {
  // Follows whose status window ran out while their message was unmounted (this one is checked as it starts polling).
  for (const [other, known] of followed) if (other !== operationId && !pollers.has(other) && currentTimeMs() - known.at > STATUS_FOR_MS) closeOperation(known.viewerKey, other, true);
  const known = followed.get(operationId);
  // One start for the operation: the cadence and the 24 h window both count from it (Remy).
  const at = known?.at ?? input.at;
  followed.set(operationId, { ...target, at, shown: known && known.shown.revision >= input.shown.revision ? known.shown : input.shown });
  setOperation(target.viewKey, { id: operationId, state: input.state });
  startPolling({ viewerKey: target.viewerKey, messageKey: target.messageKey, operationId, at, now: input.now });
}

type Poller = { viewerKey: string; messageKey: string; operationId: string; at: number; step: number; timer: unknown };
const pollers = new Map<string, Poller>();

function startPolling(input: { viewerKey: string; messageKey: string; operationId: string; at: number; now: boolean }) {
  if (pollers.has(input.operationId)) return;
  // Past its status window: nothing more to follow, nor to show as pending; the card is read again.
  if (currentTimeMs() - input.at > STATUS_FOR_MS) { closeOperation(input.viewerKey, input.operationId, true); return; }
  // A recovered operation takes up the cadence where its age puts it.
  let step = 0;
  let due = 0;
  const age = currentTimeMs() - input.at;
  while (step < STATUS_STEPS_MS.length && due + STATUS_STEPS_MS[step]! <= age) due += STATUS_STEPS_MS[step++]!;
  const poller: Poller = { ...input, step, timer: null };
  pollers.set(input.operationId, poller);
  if (input.now) void tick(poller);
  else schedule(poller);
}
function stopPolling(operationId: string) {
  const poller = pollers.get(operationId);
  if (!poller) return;
  clearClockTimeout(poller.timer);
  pollers.delete(operationId);
}
function schedule(poller: Poller, afterMs?: number) {
  // Its status window ran out: nothing more to follow, nor to show as pending; the card is read again.
  if (currentTimeMs() - poller.at > STATUS_FOR_MS) { closeOperation(poller.viewerKey, poller.operationId, true); return; }
  const delay = afterMs ?? STATUS_STEPS_MS[poller.step] ?? STATUS_EVERY_MS;
  poller.step += 1;
  poller.timer = setClockTimeout(() => void tick(poller), delay);
}
async function tick(poller: Poller) {
  if (pollers.get(poller.operationId) !== poller) return;
  if (!registrations.has(poller.messageKey)) { stopPolling(poller.operationId); return; }
  const outcome = await readStatus(poller.viewerKey, poller.operationId);
  if (pollers.get(poller.operationId) !== poller) return;
  if (outcome.kind === "closed") stopPolling(poller.operationId);
  else schedule(poller, outcome.kind === "later" ? outcome.afterMs : undefined);
}

type StatusOutcome = { kind: "open" } | { kind: "closed" } | { kind: "later"; afterMs: number };

/** `POST /link-cards/status` for an operation this browser knows. */
async function readStatus(viewerKey: string, operationId: string): Promise<StatusOutcome> {
  let data: unknown;
  try {
    ({ data } = await api.post("/link-cards/status", { operation_id: operationId }, languageHeaders()));
  } catch (error) {
    const status = httpStatus(error);
    // Not this viewer's on this Server (any more): forget it.
    if (status === 404) { closeOperation(viewerKey, operationId, false); return { kind: "closed" }; }
    if (status === 429) return { kind: "later", afterMs: retryAfterSeconds(error) * 1000 };
    return { kind: "open" };
  }
  const answer = statusAnswerSchema.safeParse(data);
  if (!answer.success) return { kind: "open" };
  // The viewer may not read this receipt now (that never means "not executed"):
  // nothing more to follow; the card is read again under their current access.
  if (answer.data.state === "not_visible") { closeOperation(viewerKey, operationId, true); return { kind: "closed" }; }
  applyReceipt(viewerKey, answer.data as Receipt);
  return TERMINAL.has(answer.data.state) ? { kind: "closed" } : { kind: "open" };
}

/** The view a record belongs to, while its message is mounted. */
function viewOfRecord(record: LinkCardOperationRecord, viewerKey: string): FollowTarget | null {
  const messageKey = `${viewerKey}|${record.message_id}`;
  const view = mountedView(messageKey);
  const url = view ? urlForHash(messageKey, record.url_sha256) : null;
  return view && url ? { viewerKey, messageKey: view.key, viewKey: linkCardViewKey(view, url), url } : null;
}

/**
 * A receipt from status. A toast at most once per receipt revision in this
 * tab (its own follow; the record for an operation it doesn't follow), never
 * one a reload already showed (the record): the App's words only from this
 * status (Raft's gates passed), else Raft's hint for a new state. A terminal
 * receipt ends the view's pending state.
 */
function applyReceipt(viewerKey: string, receipt: Receipt) {
  const known = followed.get(receipt.operation_id);
  const record = findRecord(viewerKey, { operationId: receipt.operation_id });
  if (!known && !record) return;
  const shown = known?.shown ?? { revision: record?.toasted_revision ?? 0, state: record?.toasted_state };
  if (receipt.receipt_revision > shown.revision) {
    const appToast = receipt.app_result?.toast;
    if (appToast) showToast(appToast.tone, appToast.text);
    else if (receipt.state !== shown.state) showStateHint(backgroundFormat(), receipt.state);
    if (known) known.shown = { revision: receipt.receipt_revision, state: receipt.state };
    if (record) patchRecord(viewerKey, { operationId: receipt.operation_id }, { toasted_revision: Math.max(receipt.receipt_revision, record.toasted_revision ?? 0), toasted_state: receipt.state });
  }
  if (TERMINAL.has(receipt.state)) { closeOperation(viewerKey, receipt.operation_id, true); return; }
  const target = known ?? (record ? viewOfRecord(record, viewerKey) : null);
  if (target) setOperation(target.viewKey, { id: receipt.operation_id, state: receipt.state });
}

/**
 * The operation is finished or no longer followed: forget it, end the view's
 * pending state and, if asked and the message is still shown, read the card
 * again. The view comes from this tab's follow, so it is found even when
 * another tab has deleted the record already.
 */
function closeOperation(viewerKey: string, operationId: string, reread: boolean) {
  const known = followed.get(operationId);
  const record = findRecord(viewerKey, { operationId });
  followed.delete(operationId);
  stopPolling(operationId);
  forgetRecord(viewerKey, { operationId });
  const target = known ?? (record ? viewOfRecord(record, viewerKey) : null);
  if (!target) return;
  setViewState(target.viewKey, (current) => (current.operation?.id === operationId ? { ...current, operation: undefined } : current));
  // A read already on its way (the one after execute's answer) may predate the
  // end: refresh reads once more after it (Remy).
  const busy = viewState(target.viewKey).busy;
  if (reread && (!busy || busy === "refreshing")) void refresh(target.viewKey, target.messageKey, target.url);
}

/** Views whose read after an answer is on its way, and whether another one was asked for meanwhile. */
const refreshing = new Map<string, { again: boolean }>();

/**
 * The read after an answer: the view is pending until it returns. Only while
 * the message is mounted, in each place it is (a channel and a thread panel).
 * Asked for again while one is on its way (the operation ended meanwhile),
 * it reads once more after that one, so the card shown is never the one read
 * before the end.
 */
async function refresh(viewKey: string, messageKey: string, url: string) {
  const running = refreshing.get(viewKey);
  if (running) { running.again = true; return; }
  const run = { again: false };
  refreshing.set(viewKey, run);
  try {
    do {
      run.again = false;
      const views = [...new Set([...registrations.get(messageKey) ?? []].map((registration) => registration.view))];
      if (!views.length) break;
      setBusy(viewKey, "refreshing");
      await Promise.all(views.map((view) => view.reread(url)));
    } while (run.again);
  } finally {
    refreshing.delete(viewKey);
    clearBusy(viewKey);
  }
}

// Receipt hints (RFC 076 §6.8) arrive on the viewer's own socket for this
// Server. They carry no content: an operation this browser knows is read again.
let hintSockets: Socket[] = [];
let hintsListening = false;
let stopFollowingSockets: (() => void) | null = null;
function onOperationChanged(payload: unknown) {
  const hint = operationChangedSchema.safeParse(payload);
  if (!hint.success) return;
  const viewerKey = linkPreviewViewerKey(useAuthStore.getState().user?.id, useServerStore.getState().current?.id);
  const known = followed.get(hint.data.operation_id);
  const record = findRecord(viewerKey, { operationId: hint.data.operation_id });
  if (!known && !record) return;
  if (hint.data.receipt_revision <= (known ? known.shown.revision : record?.toasted_revision ?? 0)) return;
  void readStatus(known?.viewerKey ?? viewerKey, hint.data.operation_id);
}
function listenForHints() {
  if (hintsListening) return;
  hintsListening = true;
  const attach = (socket: Socket) => {
    socket.on(LINK_CARD_OPERATION_CHANGED_EVENT, onOperationChanged);
    hintSockets.push(socket);
  };
  attach(getSocket());
  stopFollowingSockets = onSocketCreated(attach);
}

// ---------------------------------------------------------------------------
// Presses.

type PressContext = { viewerKey: string; viewKey: string; view: LinkCardMessageView; url: string; format: Format; owner: string };
/** The press each view's dialog confirms. */
const pressContexts = new Map<string, PressContext>();
/** Undo windows running, by view. */
const holds = new Map<string, { undo: () => void }>();

const handleFor = (result: CardResult, actionId: string): string | undefined =>
  result.actions?.find((action: LinkCardActionHandle) => action.action_id === actionId)?.handle;

/** The enabled execute button `actionId` of a card, with the same kind of confirmation. */
function sameExecuteButton(result: CardResult, action: ExecuteAction): LinkCardButton | null {
  for (const node of Object.values(result.cardV2?.elements ?? {})) {
    if (node.type !== "Button" || node.props.disabledReason || node.props.action.kind !== "execute") continue;
    if (node.props.action.action_id === action.action_id && ("confirm" in node.props.action) === ("confirm" in action)) return node.props;
  }
  return null;
}

/**
 * A button of a v2 card was pressed. `navigate` is a link and never comes
 * here. Nothing starts while the view is busy or has an open operation.
 */
export async function pressLinkCardButton({ result, button, owner, format }: { result: CardResult; button: LinkCardButton; owner: string; format: Format }) {
  const view = result.view;
  const action = button.action;
  if (!view || action.kind === "navigate" || button.disabledReason) return;
  const viewerKey = viewerKeyOf(view.key);
  const viewKey = linkCardViewKey(view, result.url);
  const state = viewState(viewKey);
  if (state.busy || state.operation || useLinkCardActionStore.getState().unavailable[viewerKey]) return;
  latestFormat = format;
  const context: PressContext = { viewerKey, viewKey, view, url: result.url, format, owner };

  if (action.kind === "read") {
    setBusy(viewKey, "reading", READ_BUSY_KEY);
    const read = await view.reread(result.url);
    if (read.kind === "failed") showWarning(format, "message.appLink.action.readFailed");
    clearBusy(viewKey);
    return;
  }

  let card = result;
  let pressed: LinkCardButton = button;
  let handle = handleFor(card, action.action_id);
  if (!handle) return;
  // An old handle is read again first, then used (addendum 5 §3).
  if (card.readAt === undefined || currentTimeMs() - card.readAt > LINK_CARD_HANDLE_FRESH_MS) {
    setBusy(viewKey, "reading", action.action_id);
    const read = await view.reread(result.url);
    const fresh = read.kind === "read" && read.result?.kind === "card" ? read.result : null;
    const again = fresh ? sameExecuteButton(fresh, action) : null;
    handle = fresh && again ? handleFor(fresh, action.action_id) : undefined;
    if (!fresh || !again || !handle) {
      clearBusy(viewKey);
      showWarning(format, read.kind === "failed" ? "message.appLink.action.readFailed" : "message.appLink.action.changed");
      return;
    }
    card = fresh;
    pressed = again;
  }
  const pressedAction = pressed.action as ExecuteAction;
  if ("confirm" in pressedAction) await prepare(context, card, pressedAction.action_id, handle);
  else hold(context, pressedAction.action_id, handle, pressedAction.undoWindowMs, pressed.label);
}

/** `POST /link-cards/prepare`, then Raft's dialog with the App's description. */
async function prepare(context: PressContext, card: CardResult, actionId: string, handle: string) {
  const { viewKey, format } = context;
  // The schema requires it on a v2 card; without it there is nothing to claim.
  if (!card.businessRevision) { clearBusy(viewKey); return; }
  setBusy(viewKey, "preparing", actionId);
  let data: unknown;
  try {
    ({ data } = await api.post("/link-cards/prepare", { handle, claimed: { business_revision: card.businessRevision } }, languageHeaders()));
  } catch (error) {
    await actionFailed(context, error, "prepare");
    return;
  }
  const answer = prepareAnswerSchema.safeParse(data);
  if (!answer.success) { clearBusy(viewKey); showWarning(format, "message.appLink.action.prepareFailed"); return; }
  const prepared = answer.data;
  if ("status" in prepared) { clearBusy(viewKey); showStateHint(format, "refused"); return; }
  pressContexts.set(viewKey, context);
  setViewState(viewKey, (current) => ({
    operation: current.operation, busy: "confirming", actionId,
    confirm: {
      owner: context.owner, handle, prepared: { id: prepared.prepared_action_id, digest: prepared.prepared_digest },
      description: prepared.description, executing: false,
    },
  }));
}

/** Raft's dialog was confirmed: execute with the prepared id and digest. The dialog closes on the answer. */
export async function confirmLinkCardAction(viewKey: string) {
  const state = viewState(viewKey);
  const context = pressContexts.get(viewKey);
  const confirm = state.confirm;
  if (!confirm || confirm.executing || !context) return;
  setViewState(viewKey, (current) => ({ ...current, confirm: current.confirm && { ...current.confirm, executing: true } }));
  await execute(context, state.actionId ?? "", confirm.handle, confirm.prepared);
}

/** Cancel, Esc, or the chip that asked went away: nothing is sent (the prepared record just expires). */
export function cancelLinkCardAction(viewKey: string) {
  const confirm = viewState(viewKey).confirm;
  if (!confirm || confirm.executing) return;
  pressContexts.delete(viewKey);
  clearBusy(viewKey);
}

/**
 * The undo window: a toast counts it down with Undo; when it ends, execute
 * once, whatever the hover card does meanwhile. The toast has no timeout of
 * its own, so hovering it doesn't stretch the window. Raft shows one toast at
 * a time: if a newer one replaces it (or it is swiped away) while the window
 * runs, it comes back once, so Undo stays reachable (addendum 5 §3).
 */
function hold(context: PressContext, actionId: string, handle: string, windowMs: number, label: string) {
  const { viewKey, format } = context;
  setBusy(viewKey, "holding", actionId);
  const deadline = currentTimeMs() + windowMs;
  let settled = false;
  let shown = 0;
  let toastId = "";
  const settle = () => {
    settled = true;
    clearClockTimeout(timer);
    holds.delete(viewKey);
    toast.dismiss(toastId);
  };
  const undo = () => {
    if (settled) return;
    settle();
    clearBusy(viewKey);
  };
  const show = () => {
    shown += 1;
    toastId = toast.info(format({ id: "message.appLink.action.undo.title" }, { action: label }), {
      description: <LinkCardUndoCountdown deadline={deadline} format={format} />,
      timeout: 0,
      action: { label: format({ id: "message.appLink.action.undo.action" }), onClick: undo },
      onClose: () => {
        // Not for the last moments of the window.
        if (settled || shown > 1 || deadline - currentTimeMs() < 300) return;
        // Not from inside the toast manager's own close.
        setClockTimeout(() => { if (!settled) show(); }, 0);
      },
    });
  };
  const timer = setClockTimeout(() => {
    if (settled) return;
    settle();
    void execute(context, actionId, handle, null);
  }, windowMs);
  show();
  holds.set(viewKey, { undo });
}

/**
 * `POST /link-cards/execute` (protocol §5.3): a new `client_request_id`, kept
 * before it is sent; the view's request count moves on as it goes. An answer
 * that doesn't come is asked for again with the same request
 * (LINK_CARD_EXECUTE_RETRY_MS), which Raft answers from its records if it
 * went through. The answer shows only Raft's fixed hint for its state (never
 * the App's words); the card is read again after it.
 */
async function execute(context: PressContext, actionId: string, handle: string, prepared: { id: string; digest: string } | null) {
  const { viewerKey, viewKey, view, url, format } = context;
  const clientRequestId = globalThis.crypto.randomUUID();
  const urlSha256 = await linkCardUrlSha256(url);
  if (urlSha256) putRecord(viewerKey, { message_id: view.messageId, url_sha256: urlSha256, client_request_id: clientRequestId, at: currentTimeMs() });
  view.beginExecute();
  setBusy(viewKey, "executing", actionId);
  const body = { client_request_id: clientRequestId, handle, ...(prepared ? { prepared_action_id: prepared.id, prepared_digest: prepared.digest } : {}) };
  let data: unknown;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        ({ data } = await api.post("/link-cards/execute", body, languageHeaders()));
        break;
      } catch (error) {
        const delay = LINK_CARD_EXECUTE_RETRY_MS[attempt];
        if (delay === undefined || !answerLost(error, attempt > 0)) {
          await actionFailed(context, error, "execute", { clientRequestId, repeated: attempt > 0 });
          return;
        }
        await wait(httpStatus(error) === 429 ? Math.min(60, retryAfterSeconds(error)) * 1000 : delay);
      }
    }
  } finally {
    pressContexts.delete(viewKey);
  }
  const answer = executeAnswerSchema.safeParse(data);
  if (!answer.success) {
    // Raft answered, but not in a form this client reads: look the request up.
    await actionFailed(context, null, "execute", { clientRequestId, repeated: true });
    return;
  }
  if (answer.data.state === "not_visible") {
    forgetRecord(viewerKey, { clientRequestId });
    await refresh(viewKey, view.key, url);
    return;
  }
  const { operation_id: operationId, state } = answer.data;
  showStateHint(format, state);
  if (TERMINAL.has(state)) forgetRecord(viewerKey, { clientRequestId });
  else {
    patchRecord(viewerKey, { clientRequestId }, { operation_id: operationId, toasted_state: state });
    follow(operationId, { viewerKey, messageKey: view.key, viewKey, url }, { state, at: currentTimeMs(), now: false, shown: { revision: 0, state } });
  }
  await refresh(viewKey, view.key, url);
}

/**
 * Follows an operation of this viewer on this link that a 409 named (the
 * handle was already used by it): pending until status says it is finished.
 */
async function followOperation(context: PressContext, operationId: string) {
  const { viewerKey, viewKey, view, url } = context;
  if (pollers.has(operationId)) return;
  const urlSha256 = await linkCardUrlSha256(url);
  if (urlSha256 && !findRecord(viewerKey, { operationId })) putRecord(viewerKey, { message_id: view.messageId, url_sha256: urlSha256, operation_id: operationId, at: currentTimeMs() });
  follow(operationId, { viewerKey, messageKey: view.key, viewKey, url }, { state: "sent", at: currentTimeMs(), now: false, shown: { revision: 0 } });
}

/**
 * A prepare or execute that got no usable answer. Only Raft's own words:
 * - an execute whose answer is still lost after asking again: its request id
 *   is looked up, and what it became is followed (nothing: nothing ran);
 * - 410: the card is out of date; it is read again, to try again;
 * - 409: a conflict; an operation it names is followed, and an earlier one of
 *   this view (VIEW_PENDING) is looked up by URL;
 * - 429: when to try again; 404: card actions are off, the buttons go;
 * - anything else: try again.
 */
async function actionFailed(context: PressContext, error: unknown, phase: "prepare" | "execute", request?: { clientRequestId: string; repeated: boolean }) {
  const { viewerKey, viewKey, view, url, format } = context;
  const status = httpStatus(error);
  const body = errorBody(error);
  if (request && (error === null || answerLost(error, request.repeated))) {
    setBusy(viewKey, "recovering", viewState(viewKey).actionId);
    const found = await lookupClientRequest(request.clientRequestId);
    if (found.kind === "failed" || found.kind === "none") showWarning(format, "message.appLink.action.failed");
    // Still unknown: the record stays, and a reload looks again.
    if (found.kind === "failed") clearBusy(viewKey);
    else followRequest(context, request.clientRequestId, found, "any", format);
    return;
  }
  const forget = () => { if (request) forgetRecord(viewerKey, { clientRequestId: request.clientRequestId }); };
  if (status === 410) {
    forget();
    showWarning(format, "message.appLink.action.stale");
    await refresh(viewKey, view.key, url);
    return;
  }
  if (status === 409) {
    forget();
    showWarning(format, body.code === "VIEW_PENDING" ? "message.appLink.action.conflictPending" : "message.appLink.action.conflict");
    const named = typeof body.operation_id === "string" && UUID.test(body.operation_id) ? body.operation_id : null;
    if (named) await followOperation(context, named);
    else if (body.code === "VIEW_PENDING") await recoverByUrl({ viewerKey, view, url });
    await refresh(viewKey, view.key, url);
    return;
  }
  if (status === 429) {
    forget();
    clearBusy(viewKey);
    showWarning(format, "message.appLink.action.rateLimited", { seconds: retryAfterSeconds(error) });
    return;
  }
  if (status === 404) {
    forget();
    clearBusy(viewKey);
    useLinkCardActionStore.setState((store) => ({ unavailable: { ...store.unavailable, [viewerKey]: true } }));
    showWarning(format, "message.appLink.action.unavailable");
    return;
  }
  forget();
  clearBusy(viewKey);
  showWarning(format, phase === "prepare" && status === 502 ? "message.appLink.action.prepareFailed" : "message.appLink.action.failed");
}

/** Tests: drop every view state, poller, hold and listener; the local records stay unless `storage` is cleared too. */
export function resetLinkCardActionsForTests() {
  for (const operationId of [...pollers.keys()]) stopPolling(operationId);
  followed.clear();
  refreshing.clear();
  lookupFailedAt.clear();
  for (const { undo } of [...holds.values()]) undo();
  holds.clear();
  pressContexts.clear();
  registrations.clear();
  for (const socket of hintSockets) socket.off(LINK_CARD_OPERATION_CHANGED_EVENT, onOperationChanged);
  hintSockets = [];
  stopFollowingSockets?.();
  stopFollowingSockets = null;
  hintsListening = false;
  latestFormat = null;
  useLinkCardActionStore.setState({ views: {}, unavailable: {} });
}
