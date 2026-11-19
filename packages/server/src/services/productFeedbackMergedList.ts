import { addTraceEvent } from "../tracing/semanticTrace";
import {
  PRODUCT_FEEDBACK_SOURCES,
  productFeedbackEnvForSource,
  productFeedbackUnavailableReason,
  ProductFeedbackSourceUnavailableError,
  readProductFeedbackAppsJson,
  type ProductFeedbackSource,
} from "./productFeedbackApps";
import {
  decodeProductFeedbackCursor,
  encodeProductFeedbackCursor,
  isCanonicalUuid,
  listProductFeedbackTicketsPage,
  PRODUCT_FEEDBACK_LIST_PAGE_MAX,
  productFeedbackCursorKey,
  ProductFeedbackConversationError,
  type ProductFeedbackTicket,
  type ProductFeedbackTicketListPage,
} from "./productFeedbackConversationService";
import { transientFeedbackReadFailure } from "./productFeedbackReadFailure";
import { ensureProductFeedbackRouteBinding, ProductFeedbackRouteBindingError } from "./productFeedbackRouteBindingService";
import { productFeedbackRouteBindingLog, productFeedbackSourceUnavailableLog } from "./productFeedbackSendService";

/**
 * One list of a person's feedback tickets across every Hands app Raft files
 * into (`GET /api/product-feedback/tickets?sources=all`, #triage:#366).
 *
 * A ticket lives in the app it was filed from (web, android, ios, ohos; Raft
 * Desktop files into the web app). Hands lists one app per call, ordered by
 * latest conversation activity (`latest_comment_at ?? created_at` desc, then
 * id desc; Volta, #raft-botiverse:a61e7583), and a token is bound to one app.
 * A merged page reads every configured app in parallel (one page each, from
 * that app's own Hands cursor) and k-way merges on the same key, so the
 * merged order is the order each app has.
 *
 * Paging is by boundary, not offset: the composite cursor (one signed cursor,
 * route `ticket_list_all`, bound to the user with the web app's cursor key)
 * carries, per app not yet read to its end, the Hands cursor of the page to
 * read next and the key of the last ticket of its shown. The next page
 * re-reads those pages and takes only what is older than that app's boundary,
 * so a changed `limit` or a page that shifted under a new reply neither
 * repeats nor skips what was shown (a ticket that moved to the top is one the
 * person already saw).
 * A ticket is emitted only when every app that still has unread pages has
 * shown something at least as old (its last fetched ticket): an app's unfetched
 * tickets are older than that, so nothing newer can still be hiding.
 *
 * Best effort (artin, #triage:f5d31fd0): an app that fails is left out of the
 * page and named in `unavailable_sources`; its cursor state is carried, so the
 * next page tries it again. `unread_total` is then null (unknown, as the
 * single-app degraded answer: a client keeps the value it has); it is a sum on
 * the first page only, since an app read to its end is not read again. When
 * the apps parameter itself cannot be read, every mobile app is named, also
 * one this deployment may not have: that is not knowable without it. The page fails
 * as a whole only when every app does. Transient failures are traced; the rest
 * (configuration, authorization, a bad body) are logged as the single-app list
 * logs them, so a rotated token does not hide behind "unavailable".
 */

export const PRODUCT_FEEDBACK_CLIENTS = ["web", "desktop", "android", "ios", "ohos"] as const;
export type ProductFeedbackClient = (typeof PRODUCT_FEEDBACK_CLIENTS)[number];

export type ProductFeedbackMergedTicket = Omit<ProductFeedbackTicket, "client_kind" | "client_version"> & {
  source: ProductFeedbackSource;
  client: ProductFeedbackClient;
};

export type ProductFeedbackMergedList = {
  tickets: ProductFeedbackMergedTicket[];
  next_cursor: string | null;
  /**
   * On the first page: the sum over the apps. Null (unknown) on a cursor page
   * (an app read to its end is not read again) and whenever an app is
   * unavailable: as in the degraded answer, a client keeps the value it has.
   */
  unread_total: number | null;
  /**
   * First page only: each app's own unread total, for the apps that answered
   * (no key for one that failed or that this deployment has no entry for).
   * A client keeps this map and replaces one entry per push
   * (`product_feedback:unread` for web, `product_feedback:app_unread` by its
   * `source`) or per ticket read (the detail's `unread_total` is that app's,
   * the ticket's `source` names the key), and shows the sum. Absent on cursor
   * pages, like `unread_total`.
   */
  unread_by_source?: Partial<Record<ProductFeedbackSource, number>>;
  unavailable_sources: ProductFeedbackSource[];
};

/**
 * The client a ticket was filed from. Hands echoes the create metadata's
 * `client_kind` and `client_version` (null when the ticket has none, absent
 * until Hands ships them); the app it lives in is the fallback, so a label is
 * never missing. Raft Desktop is the web client with a "Raft Desktop <ver>"
 * version (packages/web/src/feedback/agentIssueTicket.ts; the triage notice
 * reads it the same way).
 */
export function productFeedbackClient(ticket: ProductFeedbackTicket, source: ProductFeedbackSource): ProductFeedbackClient {
  const kind = ticket.client_kind;
  if (kind === "web" || (kind == null && source === "web")) {
    return ticket.client_version?.startsWith("Raft Desktop") ? "desktop" : "web";
  }
  if (kind === "android" || kind === "ios" || kind === "ohos") return kind;
  return source;
}

/**
 * A ticket as the API answers it with its app and client: Hands' raw
 * `client_kind` / `client_version` stay inside (the derived `client` is the
 * contract; the raw strings are whatever a client wrote at create).
 */
export function productFeedbackTicketWithSource(ticket: ProductFeedbackTicket, source: ProductFeedbackSource): ProductFeedbackMergedTicket {
  const { client_kind: _kind, client_version: _version, ...rest } = ticket;
  return { ...rest, source, client: productFeedbackClient(ticket, source) };
}

/** Hands' list order: latest conversation activity first, then id descending (lowercase UUID strings). */
export type ActivityKey = { readonly a: number; readonly i: string };

type ActivityFields = Pick<ProductFeedbackTicket, "latest_comment_at" | "created_at" | "id">;

export function activityKey(ticket: ActivityFields): ActivityKey {
  return { a: ticket.latest_comment_at ?? ticket.created_at, i: ticket.id.toLowerCase() };
}

/** Negative when `x` comes first (is newer) in Hands' order. */
export function compareActivity(x: ActivityKey, y: ActivityKey): number {
  return (y.a - x.a) || (x.i < y.i ? 1 : x.i > y.i ? -1 : 0);
}

export function compareByActivity(x: ActivityFields, y: ActivityFields): number {
  return compareActivity(activityKey(x), activityKey(y));
}

/** Older than the boundary: not yet emitted. */
function isAfter(ticket: ActivityFields, boundary: ActivityKey | null): boolean {
  return boundary === null || compareActivity(activityKey(ticket), boundary) > 0;
}

/** Where one app's read stands: Hands' cursor of the page to read next (null: its first page) and the last ticket of its shown. */
export type SourcePlace = { readonly c: string | null; readonly b: ActivityKey | null };

/**
 * Composite cursor body: per app not read to its end, its place. The boundary
 * is per app, so an app that was unavailable for a page loses nothing: its
 * tickets come when it is back, after older ones of other apps already shown.
 */
type CursorState = Partial<Record<ProductFeedbackSource, SourcePlace>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalid = (): never => { throw new ProductFeedbackConversationError(400, "feedback_invalid"); };

function parseActivityKey(value: unknown): ActivityKey | null {
  if (value === null) return null;
  if (
    !isRecord(value) || Object.keys(value).sort().join(",") !== "a,i"
    || !Number.isSafeInteger(value.a) || (value.a as number) < 0
    || typeof value.i !== "string" || !isCanonicalUuid(value.i) || value.i !== value.i.toLowerCase()
  ) return invalid();
  return { a: value.a as number, i: value.i };
}

function parseCursorState(raw: string): CursorState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!isRecord(value)) return invalid();
  const state: CursorState = {};
  for (const [key, place] of Object.entries(value)) {
    if (
      !(PRODUCT_FEEDBACK_SOURCES as readonly string[]).includes(key)
      || !isRecord(place) || Object.keys(place).sort().join(",") !== "b,c"
      || !(place.c === null || (typeof place.c === "string" && place.c.length > 0))
    ) return invalid();
    state[key as ProductFeedbackSource] = { c: place.c as string | null, b: parseActivityKey(place.b) };
  }
  return state;
}

function serializeCursorState(state: CursorState): string {
  // Sources in their fixed order, keys in a fixed order: the same state is the same string.
  const ordered: Record<string, { c: string | null; b: ActivityKey | null }> = {};
  for (const source of PRODUCT_FEEDBACK_SOURCES) {
    const place = state[source];
    if (place) ordered[source] = { c: place.c, b: place.b };
  }
  return JSON.stringify(ordered);
}

export type SourcePageRead = {
  source: ProductFeedbackSource;
  /** Hands' cursor this page was read with (null: the app's first page). */
  cursor: string | null;
  /** The last ticket of this app already shown (null: none yet). */
  boundary: ActivityKey | null;
  page: ProductFeedbackTicketListPage;
};

export type MergeResult = {
  tickets: ProductFeedbackMergedTicket[];
  /** Per read app: where to continue (`cursor` to re-read the page, the next one, or none when read to its end). */
  next: Partial<Record<ProductFeedbackSource, SourcePlace>>;
  /** Apps whose page was all shown and whose next page the caller should read before judging again. */
  advance: ProductFeedbackSource[];
};

/**
 * Pure: the next `limit` tickets across the pages read, each app's older than
 * its boundary, in Hands' order, and where each app continues. An app with
 * unread pages holds the merge at its last fetched ticket (frontier): nothing
 * older than that is emitted until its next page is read, so no newer ticket
 * of its can be skipped. An app whose page has nothing left to show but has a
 * next page is listed in `advance`: read it (same request) and merge again.
 */
export function mergeSourcePages(
  reads: SourcePageRead[],
  limit: number,
): MergeResult {
  const candidates: ProductFeedbackMergedTicket[] = [];
  let frontier: ActivityKey | null = null;
  const advance: ProductFeedbackSource[] = [];
  for (const read of reads) {
    const remaining = read.page.tickets.filter((ticket) => isAfter(ticket, read.boundary));
    if (remaining.length === 0 && read.page.next_hands_cursor !== null) advance.push(read.source);
    for (const ticket of remaining) candidates.push(productFeedbackTicketWithSource(ticket, read.source));
    // A page with tickets and a next page bounds what its app still holds. (An
    // empty page with a next cursor would not; Hands does not send one.)
    const last = read.page.tickets.at(-1);
    if (read.page.next_hands_cursor !== null && last) {
      const key = activityKey(last);
      if (frontier === null || compareActivity(key, frontier) < 0) frontier = key;
    }
  }
  candidates.sort(compareByActivity);

  const tickets: ProductFeedbackMergedTicket[] = [];
  for (const candidate of candidates) {
    if (tickets.length >= limit) break;
    if (frontier !== null && compareActivity(activityKey(candidate), frontier) > 0) break;
    tickets.push(candidate);
  }

  const next: MergeResult["next"] = {};
  for (const read of reads) {
    const lastOfSource = tickets.filter((ticket) => ticket.source === read.source).at(-1);
    const boundary = lastOfSource ? activityKey(lastOfSource) : read.boundary;
    const left = read.page.tickets.some((ticket) => isAfter(ticket, boundary));
    if (left) next[read.source] = { c: read.cursor, b: boundary };
    else if (read.page.next_hands_cursor !== null) next[read.source] = { c: read.page.next_hands_cursor, b: boundary };
    // else: read to its end.
  }
  return { tickets, next, advance };
}

type ListAcrossSourcesInput = {
  userId: string;
  limit: number;
  cursor?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onUpstreamServerTiming?: (value: string | null) => void;
  /** Tests: the apps JSON; by default the cached SSM parameter. */
  appsJson?: string | null;
};

/** Bounded: an app whose page was all shown is read on, within one request, at most this often. */
const ADVANCE_ROUNDS = 2;

function noteSourceFailure(source: ProductFeedbackSource, error: unknown): void {
  const transient = transientFeedbackReadFailure(error);
  const code = error instanceof ProductFeedbackConversationError ? error.code
    : error instanceof ProductFeedbackRouteBindingError ? "feedback_integration_unavailable"
    : error instanceof ProductFeedbackSourceUnavailableError ? "feedback_integration_unavailable"
    : "unknown";
  const reason = transient?.reason
    ?? (error instanceof ProductFeedbackConversationError ? error.diagnostic.stage
      : error instanceof ProductFeedbackRouteBindingError || error instanceof ProductFeedbackSourceUnavailableError ? error.reason
      : "unknown");
  addTraceEvent("server.product_feedback.list_all.source_unavailable", { source, code, transient: transient !== null, reason });
  if (transient) return;
  // Not a blip: say so where the single-app list would (fixed codes, no value).
  if (error instanceof ProductFeedbackRouteBindingError) productFeedbackRouteBindingLog(error);
  else if (error instanceof ProductFeedbackSourceUnavailableError) productFeedbackSourceUnavailableLog(error);
  else if (error instanceof ProductFeedbackConversationError) {
    console.warn(`[product-feedback] list_all source failed (${source}: ${error.code} ${error.diagnostic.stage} ${error.diagnostic.upstreamStatus ?? "-"})`);
  } else {
    console.warn(`[product-feedback] list_all source failed (${source}: ${error instanceof Error ? error.name : "UnknownError"})`);
  }
}

export async function listProductFeedbackTicketsAcrossSources(input: ListAcrossSourcesInput): Promise<ProductFeedbackMergedList> {
  const env = input.env ?? process.env;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  const cursorKey = productFeedbackCursorKey(env);
  const nowMs = input.now?.();
  const appsJson = input.appsJson === undefined ? await readProductFeedbackAppsJson() : input.appsJson;

  // The apps this deployment has: web always (its env is the legacy one), a
  // mobile source when the apps parameter has its entry. A mobile source the
  // parameter should have but cannot give right now (unread, malformed, an
  // incomplete entry) is unavailable, not absent: it is named and retried.
  const envBySource = new Map<ProductFeedbackSource, NodeJS.ProcessEnv>();
  const unavailable = new Map<ProductFeedbackSource, unknown>();
  for (const source of PRODUCT_FEEDBACK_SOURCES) {
    if (source === "web") {
      envBySource.set(source, env);
      continue;
    }
    const sourceEnv = productFeedbackEnvForSource(source, appsJson, env);
    if (sourceEnv) {
      envBySource.set(source, sourceEnv);
      continue;
    }
    const reason = productFeedbackUnavailableReason(source, appsJson, env);
    if (reason !== "source_entry_missing" && reason !== "apps_parameter_not_configured") {
      unavailable.set(source, new ProductFeedbackSourceUnavailableError(source, reason));
    }
  }

  // First page: every app from its start. Later pages: the apps the cursor
  // still names (one read to its end is gone from it; one this deployment no
  // longer has is dropped).
  // `cursor=` (empty) is a first page, as on the single-app list.
  const firstPage = !input.cursor;
  const state: CursorState = !firstPage
    ? parseCursorState(decodeProductFeedbackCursor(input.cursor!, { route: "ticket_list_all", userId: input.userId, ticketId: null, nowMs }, cursorKey))
    : Object.fromEntries([...envBySource.keys(), ...unavailable.keys()].map((source) => [source, { c: null, b: null }]));
  for (const source of Object.keys(state) as ProductFeedbackSource[]) {
    if (!envBySource.has(source) && !unavailable.has(source)) delete state[source];
  }
  // An app this page does not read (read to its end earlier) is not "unavailable".
  for (const source of [...unavailable.keys()]) if (!(source in state)) unavailable.delete(source);
  const active = (Object.keys(state) as ProductFeedbackSource[]).filter((source) => envBySource.has(source));

  const reporterIds = new Map<ProductFeedbackSource, string>();
  const reads = new Map<ProductFeedbackSource, SourcePageRead>();
  const readSources = async (sources: ProductFeedbackSource[]): Promise<void> => {
    // fanout-ok: at most the four Hands apps (PRODUCT_FEEDBACK_SOURCES), one HTTP read each, no PG
    const settled = await Promise.allSettled(sources.map(async (source) => {
      const sourceEnv = envBySource.get(source)!;
      let reporterId = reporterIds.get(source);
      if (reporterId === undefined) {
        reporterId = (await ensureProductFeedbackRouteBinding({ userId: input.userId, env: sourceEnv, fetchImpl: input.fetchImpl, nowMs })).reporterId;
        reporterIds.set(source, reporterId);
      }
      const place = state[source] ?? { c: null, b: null };
      const page = await listProductFeedbackTicketsPage({
        reporterId,
        // On a cursor page (the app has shown something) Hands' whole page, so
        // one read gets past what is shown whatever the client's limit; what is
        // shown is filtered out anyway. The first page reads at the client's limit.
        limit: place.b === null ? input.limit : PRODUCT_FEEDBACK_LIST_PAGE_MAX,
        handsCursor: place.c,
        env: sourceEnv,
        fetchImpl: input.fetchImpl,
        now: input.now,
        // One header's worth: the web app's, as the single-app list reports.
        onUpstreamServerTiming: source === "web" ? input.onUpstreamServerTiming : undefined,
      });
      reads.set(source, { source, cursor: place.c, boundary: place.b, page });
    }));
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const source = sources[index]!;
      // The request itself is at fault (a limit, a cursor Hands refused): not an outage.
      if (result.reason instanceof ProductFeedbackConversationError && result.reason.status === 400) throw result.reason;
      reads.delete(source);
      unavailable.set(source, result.reason);
    });
  };

  await readSources(active);
  let merged = mergeSourcePages([...reads.values()], input.limit);
  for (let round = 0; round < ADVANCE_ROUNDS && merged.advance.length > 0; round += 1) {
    for (const source of merged.advance) state[source] = merged.next[source] ?? { c: null, b: null };
    await readSources(merged.advance);
    merged = mergeSourcePages([...reads.values()], input.limit);
  }
  for (const [source, error] of unavailable) noteSourceFailure(source, error);
  // Every app failed: the request fails as the single-app list would, with the
  // web app's error when it has one (the route degrades or logs by its kind).
  if (reads.size === 0 && unavailable.size > 0) throw unavailable.get("web") ?? [...unavailable.values()][0];

  const nextState: CursorState = { ...merged.next };
  // An app that failed keeps its place, so a later page tries it again.
  for (const source of unavailable.keys()) if (source in state) nextState[source] = state[source];

  let nextCursor: string | null = null;
  if (Object.keys(nextState).length > 0) {
    try {
      nextCursor = encodeProductFeedbackCursor(
        { route: "ticket_list_all", userId: input.userId, ticketId: null, handsCursor: serializeCursorState(nextState), issuedAtMs: nowMs },
        cursorKey,
      );
    } catch {
      // Hands' cursors are short (under 100 bytes each); a body past the bound is ours, not the client's.
      throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
    }
  }
  // Fixed order (as serializeCursorState): the same apps give the same body.
  const unreadBySource: Partial<Record<ProductFeedbackSource, number>> = {};
  let unreadSum = 0;
  for (const source of PRODUCT_FEEDBACK_SOURCES) {
    const read = reads.get(source);
    if (!read) continue;
    unreadBySource[source] = read.page.unread_total;
    unreadSum += read.page.unread_total;
  }
  return {
    tickets: merged.tickets,
    next_cursor: nextCursor,
    unread_total: !firstPage || unavailable.size > 0 ? null : unreadSum,
    ...(firstPage ? { unread_by_source: unreadBySource } : {}),
    unavailable_sources: [...unavailable.keys()].sort(),
  };
}
