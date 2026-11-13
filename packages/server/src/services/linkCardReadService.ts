import { randomUUID } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import {
  appLinkPreviewResponseSchema, appLinkReadUrls, dropInvalidLinkCardBadgeColors, LINK_CARD_CAPABILITIES, UNREVIEWED_APP_CAPABILITY, linkCardBadgeColorsForCapabilities, linkCardExecuteActions,
  matchesAppPreview, parseAppLinkPreviewV2, parseAppLinkPreviewV3,
  linkCardInlineForCapabilities, linkCardInlineToneForCapabilities, linkCardPlacementForCapabilities, publicPreviewUrl, stripLinkCardActions,
  type AppLinkPreviewContent, type AppLinkPreviewItem, type AppLinkPreviewPrompt, type AppLinkPreviewV2Response, type AppLinkPreviewV3Response,
  type LinkCardActionTier, type LinkCardCapability,
} from "@botiverse/raft-shared/src/appLinkPreview";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { parseStrictJson } from "../lib/strictJson";
import { UUID_RE } from "../lib/messageId";
import { appHosts } from "../platform/links";
import {
  candidates, LINK_PREVIEW_PROOF_HARD_TTL_MS, linkPreviewPrompts, MAX_IN_FLIGHT_CALLBACKS_PER_USER, previewable, previewTransport, provenWithin,
  registeredApps, withCallbackSlot, type RegisteredApp,
  linkPreviewAudienceKey,
} from "./appLinkPreviewService";
import {
  LINK_CARD_TOKEN_MAX_TTL_SECONDS, linkCardMessageContentSha256, linkCardUrlSha256, newLinkCardViewNonce, signLinkCardHandle, signLinkCardReadTicket, verifyLinkCardReadTicket,
  type LinkCardHandle, type LinkCardReadTicket, type LinkCardReadTicketClaims, type LinkCardViewBinding,
} from "./linkCardTokens";
import { oidcIssuer, signAppLinkPreviewAssertion } from "./oidcService";
import { isApprovedOfficialAppClient } from "./officialAppAutoInstallService";
import { ownServerActionsInForce } from "./linkCardExecuteEligibility";
import { recordTraceEvent } from "../tracing/semanticTrace";

// The batched link-card read (RFC 076 §6.1; protocol v3.2.3 §4, addenda 1, 2
// and 4): `POST /api/messages/:messageId/link-cards/read` reads every preview
// link of one visible message (at most ten) in one request, each with its own
// credential and its own App call. It writes nothing: no Postgres row, no
// Redis key, no proof recheck (that writes last_checked_at; the sweep worker
// rechecks instead). Tickets and handles are signed, not stored.
//
// A client without card.v2, or an App that did not declare 2 in
// preview_versions: the version 1 callback, exactly as the GET sends it, and
// nothing signed. Otherwise version 2, parsed from the raw text by the strict
// parser; a failed version 2 answer is a plain link, never retried as version 1
// (addendum 4 §3). The App may answer version 2 or 3
// (RFC 076 §14); Raft reads either as version 3 items, strips and signs the one
// card, and hands a `preview.v3` client version 3, any other client version 2.
// A card Badge's colour (§15) never refuses an answer: an invalid one is
// dropped before the schema reads it, and every one for a client without
// `badge.color.v1`; each drop is a trace event.

/** Links one read covers, cards and inline labels together (addendum 2 §5). */
export const LINK_CARD_READ_MAX_URLS = 10;
/** Request bodies are refused above this many bytes before they are parsed (Tenny). */
export const LINK_CARD_READ_MAX_BODY_BYTES = 64 * 1024;
/** An over-budget link's retry hint when the viewer's callback slots are all taken: about one callback deadline. */
const SLOT_RETRY_AFTER_SECONDS = 3;
const MAX_CAPABILITY_ENTRIES = 16;
const MAX_TICKET_LENGTH = 4096;
const MAX_URL_LENGTH = 2000;
const BCP47 = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export type LinkCardReadRequest = {
  viewInstanceId: string;
  /** Only capabilities Raft knows, deduplicated and sorted (as tickets sign them); anything else is ignored. */
  capabilities: LinkCardCapability[];
  locale: string;
  /** The links to read, as WHATWG hrefs; null = every preview link of the message. */
  urls: ReadonlySet<string> | null;
  /** The client's current ticket per link (the item `url` it was issued for). */
  tickets: ReadonlyMap<string, string>;
};

const BODY_FIELDS = new Set(["view_instance_id", "capabilities", "locale", "urls", "tickets"]);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * The request body, strictly: unknown fields, wrong types and oversized lists
 * are refused (null -> 400). Fields are read as own properties only
 * (Object.hasOwn), never through the prototype, and a `__proto__` key is just
 * an unknown field.
 */
export function parseLinkCardReadBody(body: unknown): LinkCardReadRequest | null {
  if (!isPlainObject(body)) return null;
  if (Object.keys(body).some((key) => !BODY_FIELDS.has(key))) return null;
  const own = (name: string) => (Object.hasOwn(body, name) ? body[name] : undefined);
  const viewInstanceId = own("view_instance_id");
  const capabilities = own("capabilities");
  const locale = own("locale");
  if (!boundedString(viewInstanceId, 36) || !UUID_RE.test(viewInstanceId)) return null;
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITY_ENTRIES || !capabilities.every((value) => boundedString(value, 64))) return null;
  if (!boundedString(locale, 35) || !BCP47.test(locale)) return null;
  const rawUrls = own("urls");
  let urls: Set<string> | null = null;
  if (rawUrls !== undefined) {
    if (!Array.isArray(rawUrls) || rawUrls.length > LINK_CARD_READ_MAX_URLS || !rawUrls.every((value) => boundedString(value, MAX_URL_LENGTH))) return null;
    // A link that is not a preview URL can never match one: ignored, like any
    // link that is not in the message.
    urls = new Set(rawUrls.flatMap((value) => publicPreviewUrl(value)?.href ?? []));
  }
  const rawTickets = own("tickets");
  const tickets = new Map<string, string>();
  if (rawTickets !== undefined) {
    if (!isPlainObject(rawTickets)) return null;
    const entries = Object.entries(rawTickets);
    if (entries.length > LINK_CARD_READ_MAX_URLS) return null;
    for (const [url, ticket] of entries) {
      if (url.length > MAX_URL_LENGTH || !boundedString(ticket, MAX_TICKET_LENGTH)) return null;
      tickets.set(url, ticket);
    }
  }
  return {
    viewInstanceId, locale, urls, tickets,
    capabilities: LINK_CARD_CAPABILITIES.filter((known) => capabilities.includes(known)).sort(),
  };
}

/**
 * `reviewed: false` only on a version 2 or 3 item of an App acting under its
 * own-Server confirmation, read by a client that declared unreviewed_app.v1
 * (RFC 076 §17); never present otherwise.
 */
export type LinkCardReadApp = { id: string; name: string; icon: string | null; reviewed?: false };
/** A version 2 answer that shows something: `link` is omitted (F11). */
export type LinkCardV2Preview = Exclude<AppLinkPreviewV2Response, { display: "link" }>;
type LinkCardActionHandles = { ticket: LinkCardReadTicket | null; actions: { action_id: string; handle: LinkCardHandle }[] };
export type LinkCardReadItem =
  | { url: string; kind: "v1"; app: LinkCardReadApp; preview: AppLinkPreviewContent }
  | { url: string; kind: "v2"; app: LinkCardReadApp; preview: LinkCardV2Preview } & LinkCardActionHandles
  /** Only for a client that declared `preview.v3`, whichever version the App answered (RFC 076 §14). */
  | { url: string; kind: "v3"; app: LinkCardReadApp; preview: AppLinkPreviewV3Response } & LinkCardActionHandles
  | { url: string; kind: "rate_limited"; retry_after: number };
export type LinkCardReadResult = { items: LinkCardReadItem[]; prompts: AppLinkPreviewPrompt[] };

// Per-URL read budget (addendum 2 §5): 120 links per person per minute, one
// budget across all of that person's Servers. Counted in this process's memory
// like the GET limiter, because the read path writes neither Postgres nor Redis
// (addendum 4 §1): soft limit: 120 × replicas (Tenny aa028e97). Only a link
// that would call an App spends it; an over-budget link comes back as
// `rate_limited` with a retry hint, never as a whole-request 429. An App's own
// 429 is a failed callback (the link is omitted) and spends nothing extra.
export const LINK_CARD_READ_URLS_PER_MINUTE = 120;
const URL_BUDGET_WINDOW_MS = 60_000;
const urlReads = new Map<string, number[]>();
let lastBudgetSweepMs = 0;
type UrlBudget = { refund: () => void } | { retryAfter: number };
function spendUrlBudget(userId: string, nowMs: number): UrlBudget {
  // Drop people with no read in the window, at most once a window: one pass
  // per minute however many people read (Tenny cb84fbc8 #1).
  if (nowMs - lastBudgetSweepMs >= URL_BUDGET_WINDOW_MS) {
    lastBudgetSweepMs = nowMs;
    for (const [id, log] of urlReads) if (!log.length || log[log.length - 1]! <= nowMs - URL_BUDGET_WINDOW_MS) urlReads.delete(id);
  }
  const log = urlReads.get(userId) ?? [];
  urlReads.set(userId, log);
  while (log.length && log[0]! <= nowMs - URL_BUDGET_WINDOW_MS) log.shift();
  if (log.length >= LINK_CARD_READ_URLS_PER_MINUTE) {
    return { retryAfter: Math.max(1, Math.ceil((log[0]! + URL_BUDGET_WINDOW_MS - nowMs) / 1000)) };
  }
  log.push(nowMs);
  return { refund: () => { const at = log.lastIndexOf(nowMs); if (at >= 0) log.splice(at, 1); } };
}
export function __resetLinkCardReadBudgetForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card read hooks are test-only");
  urlReads.clear();
  lastBudgetSweepMs = 0;
}

/**
 * The most this provider's buttons may do (addendum 4 §2; RFC 076 §17): an
 * approved official App without an approved action endpoint in force, or
 * suspended -> navigate and read, otherwise every button; any other App ->
 * every button only where its own-Server actions are in force for this
 * viewer's Server (linkCardExecuteEligibility), else navigate only. Display
 * only: the action endpoints check again before calling the App (C2b).
 */
export function linkCardActionTier(input: { official: boolean; ownServer: boolean; actionEndpoint: string | null; suspended: boolean }): LinkCardActionTier {
  if (input.official) return input.actionEndpoint !== null && !input.suspended ? "execute" : "read";
  return input.ownServer ? "execute" : "navigate";
}

type Plan = { url: string; entry: RegisteredApp };
/** The answer to a version 2 callback (version 2 or 3) that shows something, as version 3 items (never `[]`). */
type V2Shown = { version: "v2"; plan: Plan; items: AppLinkPreviewItem[] };
type V1Shown = { version: "v1"; plan: Plan; answer: AppLinkPreviewContent };
type Outcome = V1Shown | V2Shown | { version: "omit"; plan: Plan } | { version: "rate_limited"; plan: Plan; retryAfter: number };

async function callPreview(plan: Plan, input: { serverId: string; userId: string; request: LinkCardReadRequest }, v2: boolean): Promise<V1Shown | V2Shown | null> {
  const { url, entry } = plan;
  const requestId = randomUUID();
  // v2: iss names the Server by id, which cannot be renamed; v1 keeps the
  // slug, as deployed Apps verify it (addendum 1 §5).
  const assertion = signAppLinkPreviewAssertion({ issuer: oidcIssuer(undefined, v2 ? input.serverId : entry.serverSlug), clientKey: linkPreviewAudienceKey(entry),
    userId: input.userId, serverId: input.serverId, serverRole: entry.serverRole, installationId: entry.installationId, url, requestId, now: currentDate() });
  const http = previewTransport();
  if (!v2) {
    const result = await http(entry.config.endpoint, JSON.stringify({ version: 1, url, request_id: requestId }), assertion, { response: "preview" });
    const parsed = appLinkPreviewResponseSchema.safeParse(result);
    return parsed.success ? { version: "v1", plan, answer: parsed.data } : null;
  }
  const body = { version: 2, url, request_id: requestId, client_capabilities: input.request.capabilities, locale: input.request.locale };
  const text = await http(entry.config.endpoint, JSON.stringify(body), assertion, { acceptLanguage: input.request.locale, response: "text" });
  if (typeof text !== "string") return null;
  // The strict parser on the raw text (duplicate keys, broken Unicode, C0 keys),
  // then the shared schema and the origin check.
  const answer = answerItems(parseStrictJson(text), entry.config.origin);
  if (!answer) return null;
  if (answer.invalidColors) recordBadgeColorsStripped(entry.app.id, answer.invalidColors, "invalid");
  // `[]` (version 2's `link`): the App knows this viewer may not see the object (F11).
  return answer.items.length ? { version: "v2", plan, items: answer.items } : null;
}

/**
 * One trace event per strip of card Badge colours (RFC 076 §15): the App, how
 * many colours, and why. `invalid`: not `#RRGGBB`, dropped from the App's answer
 * before the schema read it. `undeclared`: valid, but the viewer's client
 * didn't declare `badge.color.v1`. Never the colour, the link or the viewer.
 */
export const LINK_CARD_BADGE_COLOR_STRIPPED_EVENT = "server.link_card.badge_color_stripped";
function recordBadgeColorsStripped(appId: string, count: number, reason: "invalid" | "undeclared") {
  recordTraceEvent(LINK_CARD_BADGE_COLOR_STRIPPED_EVENT, { app_id: appId, count, reason });
}

type ItemOf<T extends AppLinkPreviewItem["type"]> = Extract<AppLinkPreviewItem, { type: T }>;
const itemOf = <T extends AppLinkPreviewItem["type"]>(items: readonly AppLinkPreviewItem[], type: T) =>
  items.find((item): item is ItemOf<T> => item.type === type);
const withoutType = <T extends { type: string }>({ type: _type, ...rest }: T) => rest;

/**
 * The App's answer as version 3 items, whichever version it sent and whatever
 * the client declared (RFC 076 §14); null when it is invalid. Version 2 is
 * converted up: `link` is `[]`, `connect_account` its item, and a card its
 * `inline` label, if any, then the card, `hover` unless it asked for a block.
 *
 * A card Badge colour that is not `#RRGGBB` is dropped first, from the raw
 * answer (`invalidColors` counts them): the schema is strict about colours, as
 * the clients that read Raft's answer are, so an invalid one would otherwise
 * refuse the whole card, and a colour is only cosmetic (RFC 076 §15).
 */
function answerItems(raw: Record<string, unknown>, origin: string): { items: AppLinkPreviewItem[]; invalidColors: number } | null {
  const { answer: colored, dropped: invalidColors } = dropInvalidLinkCardBadgeColors(raw);
  if (colored.version === 3) {
    const items = parseAppLinkPreviewV3(colored, origin)?.items;
    return items ? { items, invalidColors } : null;
  }
  const answer = parseAppLinkPreviewV2(colored, origin);
  if (!answer) return null;
  if (answer.display === "link") return { items: [], invalidColors };
  if (answer.display === "connect_account") return { items: [{ type: "connect_account", connect_url: answer.connect_url }], invalidColors };
  const { title, card_revision, business_revision, card, inline, placement } = answer;
  return {
    items: [...(inline ? [{ type: "inline" as const, ...inline }] : []), { type: "card", placement: placement ?? "hover", title, card_revision, business_revision, card }],
    invalidColors,
  };
}

/**
 * Version 3 items for a client without `preview.v3`, converted down to version
 * 2 (RFC 076 §14's table), then §6.1 step 8: `inline` only with `inline.v1`
 * (its tone downgraded without `inline.tone.v2`), `placement` only with
 * `block.v1`, so a client without it keeps the chip. Null when version 2 has no
 * form for them: an `inline` item with no card is the plain link.
 */
function v2Preview(items: readonly AppLinkPreviewItem[], capabilities: readonly LinkCardCapability[]): LinkCardV2Preview | null {
  const connect = itemOf(items, "connect_account");
  if (connect) return { version: 2, display: "connect_account", connect_url: connect.connect_url };
  const card = itemOf(items, "card");
  if (!card) return null;
  const label = itemOf(items, "inline");
  const inline = label && linkCardInlineForCapabilities(withoutType(label), capabilities);
  const placement = linkCardPlacementForCapabilities(card.placement === "block" ? "block" : undefined, capabilities);
  return {
    version: 2, display: "card", title: card.title, card_revision: card.card_revision, business_revision: card.business_revision, card: card.card,
    ...(inline ? { inline } : {}), ...(placement ? { placement } : {}),
  };
}

async function runPooled<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  }));
  return out;
}

/**
 * The capabilities a ticket and its handles bind: all but the ones that change
 * only how or where the answer is drawn, never what a viewer may execute (RFC
 * 076 §6.6, Tenny 0cd01252): `block.v1` moves the card (§13), `preview.v3`
 * changes the answer's version (§14), `badge.color.v1` keeps a card Badge's
 * colour (§15). The App still gets them in `client_capabilities`, but a view's ticket
 * and handles are the same with and without them, so the block card and the
 * chip's popover, or a version 2 and a version 3 read, are one view's chain.
 */
const UNBOUND_CAPABILITIES: ReadonlySet<LinkCardCapability> = new Set(["block.v1", "preview.v3", "badge.color.v1"]);
const boundCapabilities = (capabilities: readonly LinkCardCapability[]) => capabilities.filter((capability) => !UNBOUND_CAPABILITIES.has(capability));
const capabilitySet = (values: readonly string[]) => [...new Set(values)].sort().join(" ");
const sameBinding = (a: LinkCardViewBinding, b: LinkCardViewBinding) =>
  a.viewerId === b.viewerId && a.serverId === b.serverId && a.providerKind === b.providerKind && a.providerKey === b.providerKey
  && a.installationKey === b.installationKey && a.messageId === b.messageId && a.urlSha256 === b.urlSha256
  && a.registrationRevision === b.registrationRevision && capabilitySet(a.capabilities) === capabilitySet(b.capabilities);

/**
 * Tickets and handles for one shown card (protocol §3, §4.1 steps 3 and 7):
 * only when the stripped card keeps an enabled execute action (addendum 2 §5).
 * The client's earlier ticket continues its chain (same nonce, epoch + 1) only
 * if it verifies and was issued for this view and this exact binding;
 * otherwise a new nonce starts at epoch 1.
 */
function signCardTokens(input: { url: string; request: LinkCardReadRequest; binding: LinkCardViewBinding; card: ItemOf<"card">; messageContentSha256: string }): LinkCardActionHandles {
  const actions = linkCardExecuteActions(input.card.card);
  if (!actions.length) return { ticket: null, actions: [] };
  const now = currentDate();
  const iat = Math.floor(now.getTime() / 1000);
  const presented = input.request.tickets.get(input.url);
  const earlier = presented === undefined ? null : verifyLinkCardReadTicket(presented, now);
  const continues = !!earlier && earlier.viewInstanceId === input.request.viewInstanceId && sameBinding(earlier.binding, input.binding);
  const claims: LinkCardReadTicketClaims = {
    viewInstanceId: input.request.viewInstanceId,
    viewNonce: continues ? earlier.viewNonce : newLinkCardViewNonce(),
    epoch: continues ? earlier.epoch + 1 : 1,
    binding: input.binding, iat, exp: iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS,
  };
  return {
    ticket: signLinkCardReadTicket(claims),
    actions: actions.map((action) => ({
      action_id: action.actionId,
      handle: signLinkCardHandle({
        ...claims, actionId: action.actionId, cardRevision: input.card.card_revision, businessRevision: input.card.business_revision,
        // The Button props after schema defaults (variant "default", ...), so an
        // omitted default and an explicit one sign the same digest (addendum 1 §3).
        descriptorSha256: canonicalJsonSha256(action.descriptor), messageContentSha256: input.messageContentSha256, requiresPrepare: action.requiresPrepare,
      }),
    })),
  };
}

/**
 * Reads the link cards of one message the caller has already found visible
 * (`content` is its visible text). Links without a preview (no single matching
 * App, `display: "link"`, non-200, invalid, slow, oversized, visibility lost)
 * are omitted: the client shows the plain link (F11).
 */
export async function readLinkCards(input: {
  serverId: string; userId: string; messageId: string; content: string; request: LinkCardReadRequest; stillVisible: () => Promise<boolean>;
}): Promise<LinkCardReadResult> {
  // Raft's own objects' links (an Artifact's) are not counted: an App link
  // after ten of them is still read.
  const linked = appLinkReadUrls(input.content, appHosts(), LINK_CARD_READ_MAX_URLS);
  if (!linked.length) return { items: [], prompts: [] };
  const urls = input.request.urls ? linked.filter((url) => input.request.urls!.has(url)) : linked;
  if (!urls.length) return { items: [], prompts: [] };
  const now = currentDate();
  const apps = await registeredApps(input.serverId, input.userId, [...new Set(urls.map((url) => new URL(url).origin))]);
  // Suspended registrations are not in `apps`; past HARD_TTL one is unverified
  // even before the sweep suspends it. Neither is called.
  const available = apps.filter((row) => previewable(row) && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, now));
  const prompts = linkPreviewPrompts(urls, apps, now);
  const plans = urls.flatMap((url): Plan[] => {
    const matched = available.filter((row) => matchesAppPreview(url, row.config));
    return matched.length === 1 ? [{ url, entry: matched[0]! }] : [];
  });
  if (!plans.length) return { items: [], prompts };

  // Per App, not per read: a read can cover links of Apps on either side.
  const readerTakesV2 = input.request.capabilities.includes("card.v2");
  const budgets = plans.map((plan) => ({ plan, budget: spendUrlBudget(input.userId, now.getTime()) }));
  // fanout-ok: at most LINK_CARD_READ_MAX_URLS links, each with one callback and
  // one per-URL budget unit, run at most MAX_IN_FLIGHT_CALLBACKS_PER_USER at a time.
  let called = false;
  const outcomes = await runPooled(budgets, MAX_IN_FLIGHT_CALLBACKS_PER_USER, async ({ plan, budget }): Promise<Outcome> => {
    if ("retryAfter" in budget) return { version: "rate_limited", plan, retryAfter: budget.retryAfter };
    try {
      const ran = await withCallbackSlot(input.userId, async () => { called = true; return { shown: await callPreview(plan, input, readerTakesV2 && plan.entry.config.previewVersions.includes(2)) }; });
      if (!ran) {
        // Other reads of this viewer hold every callback slot: this link was
        // not sent, so it costs no budget and the client retries it shortly.
        budget.refund();
        return { version: "rate_limited", plan, retryAfter: SLOT_RETRY_AFTER_SECONDS };
      }
      return ran.shown ?? { version: "omit", plan };
    } catch { return { version: "omit", plan }; } // Never log callback URL, assertion, body or private response.
  });

  // A slow callback must not revive disabled / uninstalled / revoked / declined
  // / suspended / re-registered authority, or show an old message's links after
  // an edit, a delete or an access change: re-check once, after every callback.
  const shown = outcomes.filter((outcome): outcome is V1Shown | V2Shown => outcome.version === "v1" || outcome.version === "v2");
  const current = shown.length ? await candidates(input.serverId, input.userId, [...new Set(shown.map((outcome) => outcome.plan.entry.config.origin))]) : [];
  if (called && !await input.stillVisible()) return { items: [], prompts: [] };
  const stillValid = (entry: RegisteredApp) => current.some((row) => row.app.id === entry.app.id && row.installationId === entry.installationId
    && row.config.revision === entry.config.revision && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, currentDate()));

  // Decided on the registration as it is after the callbacks (a withdrawn
  // own-Server confirmation is not covered by the revision stillValid checks).
  // An App acting under its own-Server confirmation (RFC 076 §17) keeps its
  // acting buttons only for a client that declared unreviewed_app.v1, and
  // only that client is told it is not reviewed (`app.reviewed: false`).
  const tiers = new Map<string, LinkCardActionTier>();
  const unreviewed = new Set<string>();
  for (const outcome of shown) {
    const { app } = outcome.plan.entry;
    if (outcome.version !== "v2" || tiers.has(app.id)) continue;
    const now = current.find((row) => row.app.id === app.id);
    if (!now) continue;
    const official = await isApprovedOfficialAppClient(app.id);
    const ownServer = !official && ownServerActionsInForce(now, input.serverId) && input.request.capabilities.includes(UNREVIEWED_APP_CAPABILITY);
    if (ownServer) unreviewed.add(app.id);
    tiers.set(app.id, linkCardActionTier({ official, ownServer, actionEndpoint: now.config.actionEndpoint, suspended: now.config.suspendedAt !== null }));
  }
  const messageContentSha256 = linkCardMessageContentSha256(input.content);
  const items = outcomes.flatMap((outcome): LinkCardReadItem[] => {
    const { url, entry } = outcome.plan;
    if (outcome.version === "rate_limited") return [{ url, kind: "rate_limited", retry_after: outcome.retryAfter }];
    if (outcome.version === "omit" || !stillValid(entry)) return [];
    // The icon is the one Raft stores for the App, never a URL from the answer.
    const app: LinkCardReadApp = { id: entry.app.id, name: entry.app.name, icon: entry.app.icon };
    if (outcome.version === "v1") return [{ url, kind: "v1", app, preview: outcome.answer }];
    if (unreviewed.has(entry.app.id)) app.reviewed = false;
    try {
      const { capabilities } = input.request;
      // Only the card is stripped. connect_account is Raft's fixed template with
      // one navigate button, not an App Button: capabilities don't strip it
      // (RFC 076 §6.1).
      const actionable = outcome.items.map((item) => item.type === "card"
        ? { ...item, card: stripLinkCardActions(item.card, { tier: tiers.get(entry.app.id) ?? "navigate", capabilities }) } : item);
      // Card Badge colours only reach a client that declared badge.color.v1
      // (RFC 076 §15), whichever version it reads: an older client reads each
      // item strictly. Per read, from this App answer: nothing is cached
      // across viewers.
      const { items, stripped: undeclaredColors } = linkCardBadgeColorsForCapabilities(actionable, capabilities);
      if (undeclaredColors) recordBadgeColorsStripped(entry.app.id, undeclaredColors, "undeclared");
      // Signed for the stripped card, whichever version the App answered and the
      // client reads (§14): the same ticket and handles either way.
      const card = itemOf(items, "card");
      const binding: LinkCardViewBinding = {
        viewerId: input.userId, serverId: input.serverId, providerKind: "app", providerKey: entry.app.key, installationKey: entry.installationId,
        messageId: input.messageId, urlSha256: linkCardUrlSha256(url), registrationRevision: entry.config.revision, capabilities: boundCapabilities(capabilities),
      };
      const tokens = card ? signCardTokens({ url, request: input.request, binding, card, messageContentSha256 }) : { ticket: null, actions: [] };
      if (capabilities.includes("preview.v3")) {
        // Every item; besides the colours above, only the inline badge's tone depends on the client (inline.tone.v2).
        const preview = { version: 3 as const, items: items.map((item) => item.type === "inline" ? linkCardInlineToneForCapabilities(item, capabilities) : item) };
        return [{ url, kind: "v3", app, preview, ...tokens }];
      }
      const preview = v2Preview(items, capabilities);
      return preview ? [{ url, kind: "v2", app, preview, ...tokens }] : [];
    } catch { return []; }
  });
  return { items, prompts };
}
