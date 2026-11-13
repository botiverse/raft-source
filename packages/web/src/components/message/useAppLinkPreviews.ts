import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IntlContext } from "react-intl";
import type { RefObject } from "react";
import { z } from "zod";
import { useShallow } from "zustand/react/shallow";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { AppLinkPreviewContent, LinkCardReadAnswerItem, LinkCardV2 } from "@botiverse/raft-shared/src/appLinkPreview";
import { appLinkPreviewListResponseSchema, appLinkReadUrls, publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
import { useArtifactAppHosts } from "../../apps/artifacts";
import { parseRetryAfterMs } from "../../api/overloadRetry";
import { htmlLangForLocale } from "../../i18n/locale";
import { useLocale } from "../../i18n/LocaleProvider";
import { useAuthStore } from "../../store/authStore";
import {
  linkPreviewAppKey,
  linkPreviewConversationKey,
  linkPreviewViewerKey,
  useLinkPreviewConsentStore,
} from "../../store/linkPreviewConsentStore";
import type { LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import { INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { registerLinkCardMessageView } from "./linkCardExecute";
import type { LinkCardMessageView, LinkCardReread } from "./linkCardExecute";
import { bumpLinkCardViewSeq, newLinkCardView, readMessageLinks } from "./linkCardRead";
import { appLinkResultOfItem } from "./linkCardItems";
import type { AppLinkDrawn } from "./linkCardItems";
import type { LinkCardView, MessageLinksRead } from "./linkCardRead";

/** The App as Raft stores it: its name and its uploaded icon (never an image from the preview). */
export type AppLinkApp = { name: string; icon: string | null };

/** A handle Raft signed for one enabled execute button of this view (protocol §4.1 step 7). */
export type LinkCardActionHandle = Extract<LinkCardReadAnswerItem, { kind: "v2" }>["actions"][number];

/**
 * How one link of a message is shown (protocol v3.2.3 addendum 5 §2). A link
 * with no result here stays the author's link: `display: "link"`, failures,
 * timeouts, invalid answers and `rate_limited` all come out as no entry.
 *
 * - `card`: a chip with the App's title and icon, and a hover card. A v1
 *   answer brings `card` (the read-only catalog); a v2 answer `cardV2` (its
 *   elements and buttons), the chip's own `inlineTitle` when it has one, the
 *   handles for its execute buttons (`actions`), the `businessRevision`
 *   prepare claims and when they were read (`readAt`, client clock). As a
 *   mounted message returns it, a v2 card also carries `view`: the message
 *   view its buttons act through (linkCardExecute.tsx; never cached). A v3
 *   answer is read the same way, with `drawn` (linkCardItems.ts): whether
 *   the link is a chip and where its card goes (hover, block or none).
 * - `connect_account`: a chip with the App's icon and the shortened address;
 *   the hover card holds Raft's own words and a button to `connectUrl`. Only
 *   a v2 or v3 read produces it.
 * - `consent`: the viewer hasn't answered this App yet. A grey chip with
 *   Raft's stored name and icon and the shortened address, which asks first;
 *   nothing was asked of the App.
 * - `pending`: the viewer just allowed the App and its links are read again.
 */
export type AppLinkResult =
  | {
    kind: "card"; url: string; app: AppLinkApp; title: string; card?: AppLinkPreviewContent["card"]; cardV2?: LinkCardV2; inlineTitle?: string;
    actions?: readonly LinkCardActionHandle[]; businessRevision?: string; readAt?: number; view?: LinkCardMessageView; drawn?: AppLinkDrawn;
  }
  | { kind: "connect_account"; url: string; app: AppLinkApp; connectUrl: string }
  | { kind: "consent"; url: string; app: LinkPreviewApp }
  | { kind: "pending"; url: string };

/** A message's results, by the link's normalized URL (`appLinkResultKey`). */
export type AppLinkResults = ReadonlyMap<string, AppLinkResult>;

const NO_RESULTS: AppLinkResults = new Map();

/** The key a message link is looked up by: its WHATWG href, for previewable links only. */
export function appLinkResultKey(url: string): string | null {
  return publicPreviewUrl(url)?.href ?? null;
}

/**
 * The words on a card chip. v1 has only `title`; a v2 answer's `inline.title`
 * takes its place when it has one (addendum 5 §2). `inline.badge` is never on
 * the chip: results don't carry it.
 */
export function appLinkChipTitle(result: Extract<AppLinkResult, { kind: "card" }>): string {
  return result.inlineTitle ?? result.title;
}

// `prompts` is read on its own: a prompt the client can't read is dropped
// without hiding the previews next to it (and the reverse).
const promptListSchema = z.array(z.object({
  url: z.string().refine((value) => !!publicPreviewUrl(value)),
  app: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(300), icon: z.string().max(2000).nullable() }),
})).max(10);

/** Reads a v1 list answer into per-link results. Anything it can't read is no result; one prompt per App. */
export function readAppLinkPreviewAnswer(data: unknown): AppLinkResults {
  const results = new Map<string, AppLinkResult>();
  const previews = appLinkPreviewListResponseSchema.safeParse(data);
  if (previews.success) {
    const icons = previews.data.appIcons ?? {};
    for (const preview of previews.data.previews) {
      const key = appLinkResultKey(preview.url);
      if (!key || results.has(key)) continue;
      const icon = Object.hasOwn(icons, preview.url) ? icons[preview.url] ?? null : null;
      results.set(key, { kind: "card", url: key, app: { name: preview.appName, icon }, title: preview.title, card: preview.card });
    }
  }
  return withPrompts(results, data);
}

/**
 * Links a batched read answered `rate_limited`, read again after `afterMs`.
 * `backoffMs` is the wait without the jitter: the answer's longest
 * `retry_after` (clamped to 1-60 s), or, for the view's later re-reads,
 * double the last wait if that is longer (nextLinkCardRetry), 60 s at most.
 * `afterMs` adds up to a second at random, so a page's links don't retry
 * together; 60 s at most.
 */
export type LinkCardRetry = { urls: string[]; afterMs: number; backoffMs: number };

const RETRY_AFTER_MAX_MS = 60_000;
/** Up to this much is added at random to a retry's wait, so a page's links don't all retry at the same moment. */
const RETRY_JITTER_MS = 1_000;
let retryRandom: () => number = Math.random;
/** Tests: the random source of the retry jitter (`null`: Math.random again). */
export function setLinkCardRetryRandomForTests(random: (() => number) | null) {
  retryRandom = random ?? Math.random;
}
const jitterMs = () => Math.floor(retryRandom() * RETRY_JITTER_MS);
const withJitter = (backoffMs: number) => Math.min(RETRY_AFTER_MAX_MS, backoffMs + jitterMs());

/**
 * The view's next re-read of `urls`: never sooner than Raft asked
 * (`retryAfterMs`: the answer's `retry_after`, a 429's `Retry-After`, or 0
 * when the re-read got no answer), and at least double the last wait
 * (`lastBackoffMs`), 60 s at most; plus the jitter.
 */
export function nextLinkCardRetry(urls: string[], lastBackoffMs: number, retryAfterMs: number): LinkCardRetry {
  const backoffMs = Math.min(RETRY_AFTER_MAX_MS, Math.max(retryAfterMs, lastBackoffMs * 2));
  return { urls, backoffMs, afterMs: withJitter(backoffMs) };
}

/** A read answered 429: its response's headers. */
const tooManyRequestsSchema = z.object({ response: z.object({ status: z.literal(429), headers: z.unknown() }) });
/**
 * How long a read that failed with a 429 was asked to wait: its `Retry-After`
 * (seconds or an HTTP date; parseRetryAfterMs), 60 s at most; 0 otherwise.
 * Both reads' limiters send it on a 429 (the server exposes it to the web).
 */
function retryAfterMsOf(error: unknown): number {
  const tooMany = tooManyRequestsSchema.safeParse(error);
  const waitMs = tooMany.success ? parseRetryAfterMs(tooMany.data.response.headers, currentTimeMs()) : null;
  return waitMs ? Math.min(RETRY_AFTER_MAX_MS, waitMs) : 0;
}

/** The wait rate_limited links ask for: their longest `retry_after` (seconds), clamped to 1-60 s, in ms. */
const rateLimitedBackoffMs = (retryAfters: number[]) => Math.min(60, Math.max(1, ...retryAfters)) * 1000;

/**
 * Reads a batched read's items (linkCardRead.ts) into per-link results, with
 * the answer's prompts read as the GET's, and the links to read again. `v1`
 * is the card it is today; `v2` and `v3` as appLinkResultOfItem reads them;
 * `rate_limited` stays the plain link for now.
 */
export function readLinkCardAnswer(items: LinkCardReadAnswerItem[], data: unknown): { results: AppLinkResults; retry: LinkCardRetry | null } {
  const results = new Map<string, AppLinkResult>();
  const later = new Map<string, number>();
  for (const item of items) {
    const key = appLinkResultKey(item.url);
    if (!key || results.has(key) || later.has(key)) continue;
    if (item.kind === "rate_limited") { later.set(key, item.retry_after); continue; }
    const app = { name: item.app.name, icon: item.app.icon };
    if (item.kind === "v1") { results.set(key, { kind: "card", url: key, app, title: item.preview.title, card: item.preview.card }); continue; }
    // v2 and v3 (linkCardItems.ts): a card, a connect_account chip, or (v3) a chip with no card.
    const result = appLinkResultOfItem(item, key, app);
    if (result) results.set(key, result);
  }
  if (!later.size) return { results: withPrompts(results, data), retry: null };
  const backoffMs = rateLimitedBackoffMs([...later.values()]);
  return { results: withPrompts(results, data), retry: { urls: [...later.keys()], backoffMs, afterMs: withJitter(backoffMs) } };
}

/** Adds an answer's prompts (the GET's and the batched read's are alike) to its results. */
function withPrompts(results: Map<string, AppLinkResult>, data: unknown): AppLinkResults {
  const prompts = promptListSchema.safeParse((data as { prompts?: unknown } | null)?.prompts ?? []);
  if (prompts.success) {
    const asked = new Set<string>();
    for (const prompt of prompts.data) {
      const key = appLinkResultKey(prompt.url);
      if (!key || results.has(key) || asked.has(prompt.app.id)) continue;
      asked.add(prompt.app.id);
      results.set(key, { kind: "consent", url: key, app: prompt.app });
    }
  }
  return results;
}

type Loaded = {
  scope: string;
  /** How it was read: "v1" (the GET), or "v2:<locale>" (the batched read, in that UI language). */
  mode: string;
  /** Read with the batched read (false: the GET); it says how many links it covers. */
  batched: boolean;
  results: AppLinkResults;
  /** The consent epochs when this answer was asked for; a later Allow makes it stale. */
  epochs: Record<string, number>;
  /** `cacheGeneration` when this answer was asked for. */
  generation: number;
  /**
   * Batched read: its rate_limited links, to read again after `afterMs` while
   * the message is on screen (the view's re-reads, LINK_CARD_READ_RETRIES at
   * most). Each of them is also `unread`.
   */
  retry?: LinkCardRetry;
  /**
   * The links no read has answered yet: plain because a read failed, timed
   * out or was answered rate_limited, never because the App answered them
   * plain (`display: "link"`, or no App: those are final). A hover over one
   * no re-read is due for reads it (LINK_CARD_HOVER_COOLDOWN_MS). Not cached
   * while there are any.
   */
  unread?: ReadonlySet<string>;
  /**
   * The latest read of the whole message failed or timed out (it was not
   * cancelled), and which failure that was (`wholeReadFailures`): read again
   * when the row comes back on screen (LINK_CARD_REENTRY_COOLDOWN_MS). Kept
   * by what is read into the answer meanwhile. Never cached.
   */
  failure?: number;
};
type ConsentResult = Extract<AppLinkResult, { kind: "consent" }>;
const consentsOf = (results: AppLinkResults) => [...results.values()].filter((result): result is ConsentResult => result.kind === "consent");
/** An answer that read every link it covers: the only kind the cache keeps. */
const complete = (answer: Loaded) => answer.failure === undefined && !answer.unread?.size;
/** Counts failed whole reads, so each failure has its own number. */
let wholeReadFailures = 0;

// The answers read this session, by viewer, server, message and content (the
// links): a row that remounts (the virtual timeline mounts only the rows near
// the view) shows them again without a request. In memory only, bounded, most
// recently used last; a failed read is not kept, so it is retried. An entry
// read another way (`mode`: the GET, or the batched read in another language)
// is shown while the row reads it again.
// An entry keeps the consent epochs it was read at, so one that carried an
// App's prompt is stale once that App is allowed and is read again. An entry
// read while the App was declined carries no prompt for it, so its epoch can't
// tell: allowing an App (Settings › Applications) drops every entry that
// doesn't carry its prompt, and those rows read again once in view. Any
// decline drops every entry: no prompt and no card of a declined App comes
// back from here.
// An answer with rate_limited links is cached once its re-reads have read
// them all, unless an App was allowed or declined since it was asked for
// (`cacheGeneration` moved): the entry the cache would have dropped then
// stays out. A failed read is never kept (`complete`).
const RESULT_CACHE_MAX = 300;
const resultCache = new Map<string, Loaded>();
let cacheGeneration = 0;

// When each message (`scope`) was last sent a read of the whole message, for
// the re-entry cooldown; and per link of a message (`scope` and URL) the
// earliest a hover may read it (its hover cooldown, or the last retry_after
// Raft gave it). In memory, bounded like the cache.
const wholeReadSentAt = new Map<string, number>();
const hoverNotBefore = new Map<string, number>();
function remember(map: Map<string, number>, key: string, at: number, stale: (value: number, now: number) => boolean) {
  map.set(key, Math.max(at, map.get(key) ?? 0));
  if (map.size <= RESULT_CACHE_MAX) return;
  const now = currentTimeMs();
  for (const [other, value] of map) if (stale(value, now)) map.delete(other);
  while (map.size > RESULT_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
const hoverKey = (scope: string, url: string) => `${scope}\n${url}`;
/** No hover read of `url` in this message before `at`. */
const holdHoverRead = (scope: string, url: string, at: number) => remember(hoverNotBefore, hoverKey(scope, url), at, (value, now) => value <= now);

// The page's link-card reads wait together (Remy). Raft's read budgets are the
// person's (120 links and 120 requests a minute, six callback slots; one
// budget across all of their Servers), not a message's: once Raft answers any
// read with a 429 (its `Retry-After`) or with rate_limited links (their
// longest `retry_after`), no link-card read of that person goes before then,
// from any message on any Server: a first read, a whole read again (after
// Allow, in another language, on re-entry), a rate-limited re-read, a hover
// read, a button's re-read (Refresh). The hold is 60 s at most; each read let
// go after it waits up to a second more at random, past those 60 s if need
// be, so they don't all go at once. One time, only ever moved later, keyed by
// the person: a Server switch keeps it, logging out or another person signing
// in drops it. It only delays reads: each message's own waits, cooldowns and
// caps stay as they are. In memory.
let readHold: { key: string; until: number } | null = null;
/**
 * Holds the reads of person `key` for `waitMs` from now, unless they are held
 * longer already. An answer for someone no longer signed in (a read still out
 * when they logged out and another person signed in) leaves the hold alone:
 * the hold is the person's who is signed in now (Remy).
 */
function holdReads(key: string, waitMs: number) {
  if (waitMs <= 0 || key !== useAuthStore.getState().user?.id) return;
  const until = currentTimeMs() + waitMs;
  if (readHold?.key !== key || readHold.until < until) readHold = { key, until };
}
/** How much longer the reads of person `key` are held (0: they may go). */
const readHoldLeft = (key: string) => (readHold?.key === key ? Math.max(0, readHold.until - currentTimeMs()) : 0);
useAuthStore.subscribe((state) => {
  if (readHold && readHold.key !== state.user?.id) readHold = null;
});
/**
 * Runs `go` after `delayMs` and once the reads of `key` are no longer held,
 * waiting again if the hold moves later meanwhile; at once if both have
 * passed (no 0 ms timer). Returns its cancel.
 */
function afterReadHold(key: string, delayMs: number, go: () => void): () => void {
  let timer: unknown = null;
  const check = () => {
    timer = null;
    const held = readHoldLeft(key);
    // The jitter is added past the hold, never cut at 60 s with it, so reads let go at the cap don't go together (Remy).
    if (held > 0) timer = setClockTimeout(check, held + jitterMs());
    else go();
  };
  if (delayMs > 0) timer = setClockTimeout(check, delayMs);
  else check();
  return () => {
    if (timer !== null) clearClockTimeout(timer);
    timer = null;
  };
}
/** Resolves once the reads of `key` are no longer held (afterReadHold), or when `signal` aborts. */
function readHoldPassed(key: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || !readHoldLeft(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const abort = () => {
      cancel();
      resolve();
    };
    const cancel = afterReadHold(key, 0, () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
function cachedAnswer(scope: string): Loaded | undefined {
  const answer = resultCache.get(scope);
  if (answer) {
    resultCache.delete(scope);
    resultCache.set(scope, answer);
  }
  return answer;
}
function cacheAnswer(answer: Loaded) {
  resultCache.delete(answer.scope);
  resultCache.set(answer.scope, answer);
  while (resultCache.size > RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}
export function clearAppLinkPreviewCacheForTests() {
  resultCache.clear();
  wholeReadSentAt.clear();
  hoverNotBefore.clear();
  readHold = null;
  retryRandom = Math.random;
}
useLinkPreviewConsentStore.subscribe((state, previous) => {
  const answered = Object.entries(state.status).filter(([key, status]) => previous.status[key] !== status);
  if (answered.some(([, status]) => status === "declined")) {
    resultCache.clear();
    cacheGeneration += 1;
    return;
  }
  for (const [key, status] of answered) {
    if (status !== "allowed") continue;
    cacheGeneration += 1;
    for (const [scope, entry] of resultCache) {
      if (!consentsOf(entry.results).some((prompt) => key.endsWith(`:${prompt.app.id}`))) resultCache.delete(scope);
    }
  }
});

/** The links a read covers: ten with the batched read (addendum 2 §5), three with the GET. */
const linkLimit = (batched: boolean) => (batched ? 10 : 3);
/**
 * The links a read of `content` covers, counted as the server counts them
 * (shared appLinkReadUrls): Raft's own objects' links (an Artifact's, on
 * `hosts`, the app hosts the web recognises it on: useArtifactAppHosts, the
 * server's own list once it has arrived) are left out before the limit, so
 * they never take an App link's place.
 */
const readLinks = (content: string, batched: boolean, hosts: readonly string[]) => appLinkReadUrls(content, hosts, linkLimit(batched));
/** The same links as `previous` (each in its place), or not. */
const sameLinks = (previous: readonly string[], next: readonly string[]) => previous.length === next.length && previous.every((url, index) => url === next[index]);
/**
 * At most this many re-reads of rate_limited links per message view, sent
 * only while it is on screen, each waiting at least the answer's
 * `retry_after` and double the last wait, 60 s at most (nextLinkCardRetry).
 * Ten keeps a link trying for about five minutes on screen (retry_after 1 s:
 * 1+2+4+8+16+32+60+60+60+60 s; 3 s, the callback-slot hint: about six and a
 * half): the six callback slots free up within a callback deadline (3 s) and
 * the 120-links-a-minute budget within a minute, so a link that is still
 * rate_limited after four of those minutes is held back by the viewer's own
 * reading, and more tries would only compete with the links they are looking
 * at. Each re-read reads only those links, and Raft still decides per link.
 */
export const LINK_CARD_READ_RETRIES = 10;
/**
 * A message whose whole read failed or timed out is read again when its row
 * comes back on screen, at most once per this after its last whole read went
 * out (a row back sooner waits on screen for the rest).
 */
export const LINK_CARD_REENTRY_COOLDOWN_MS = 30_000;
/**
 * A hover reads a link no read has answered yet (`unread`) at most once per
 * this, and never before the retry_after Raft last gave it, so a slow or
 * busy App isn't hammered (Remy).
 */
export const LINK_CARD_HOVER_COOLDOWN_MS = 30_000;
/**
 * A read of some links is sent at most this many times in all: once, and
 * again (twice at most) when its answer was dropped because an execute went
 * out meanwhile.
 */
const PARTIAL_READ_TRIES = 3;
/**
 * A batched read (of the whole message or of some links) still unanswered
 * after this is given up: it fails, so it can't hold up the reads of the
 * view that wait for it (Remy).
 */
export const LINK_CARD_READ_TIMEOUT_MS = 20_000;
/**
 * A read after Allow whose wait for the page's reads (the hold, `readHold`)
 * has lasted this long shows the allowed App's links as plain links instead
 * of pending chips until it answers, then as what it answers (Remy). Each
 * wait counts on its own: a read that waits again later (asked for again
 * after a language change or a dropped answer) gets its own. A chip that
 * looks loading for up to a minute right after Allow reads as frozen. Two
 * seconds is the longest the shortest hold can last (retry_after's 1 s floor
 * plus up to 999 ms of jitter), so a 1 s hold never turns a chip plain and
 * back within a moment, while any longer one (the 3 s callback-slot hint, a
 * 429's minute) shows the plain link after 2 s. With no hold nothing changes:
 * the pending chip stays until the read answers, however long that takes.
 */
export const LINK_CARD_HELD_PLAIN_AFTER_MS = 2_000;
/** How a read of the whole message ended, for the reads of some links waiting for it. */
type WholeReadOutcome = "answered" | "failed" | "cancelled";

/**
 * One read (linkCardRead.ts) for person `holdKey`: sent only
 * once the page's reads are no longer held (null if `signal` aborts first;
 * `heldLong` runs if one wait for that lasts LINK_CARD_HELD_PLAIN_AFTER_MS,
 * `sent` as it goes), and an answer that asks to wait holds them: a 429
 * (`Retry-After`), or rate_limited links (their longest `retry_after`).
 * Aborted with `signal`; with `deadline`, given up LINK_CARD_READ_TIMEOUT_MS
 * after it was sent.
 */
async function readHeld(
  holdKey: string,
  input: Omit<Parameters<typeof readMessageLinks>[0], "signal">,
  signal: AbortSignal,
  { deadline, sent, heldLong }: { deadline: boolean; sent?: () => void; heldLong?: () => void },
): Promise<MessageLinksRead | null> {
  if (readHoldLeft(holdKey)) {
    // This wait's own LINK_CARD_HELD_PLAIN_AFTER_MS: every wait of every read
    // gets one, ended when the wait does (sent, or aborted) (Remy).
    const long = heldLong ? setClockTimeout(heldLong, LINK_CARD_HELD_PLAIN_AFTER_MS) : null;
    const endLong = () => {
      if (long !== null) clearClockTimeout(long);
    };
    signal.addEventListener("abort", endLong, { once: true });
    await readHoldPassed(holdKey, signal);
    endLong();
    signal.removeEventListener("abort", endLong);
  }
  if (signal.aborted) return null;
  sent?.();
  const request = new AbortController();
  const stop = () => request.abort();
  signal.addEventListener("abort", stop, { once: true });
  const timer = deadline ? setClockTimeout(stop, LINK_CARD_READ_TIMEOUT_MS) : null;
  try {
    const read = await readMessageLinks({ ...input, signal: request.signal });
    const limited = read?.batched ? read.items.flatMap((item) => (item.kind === "rate_limited" ? [item.retry_after] : [])) : [];
    if (limited.length) holdReads(holdKey, rateLimitedBackoffMs(limited));
    return read;
  } catch (error) {
    holdReads(holdKey, retryAfterMsOf(error));
    throw error;
  } finally {
    if (timer !== null) clearClockTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/**
 * A mounted message view for one `scope`: the batched read's view (protocol
 * §7.1), and how many rate-limited re-reads it has sent.
 */
type MessageView = { scope: string; view: LinkCardView | null; rereads: number };
type MessageViews = { current: MessageView | null };
/** The message view for `scope`: a new one when the scope changes. */
function messageViewFor(views: MessageViews, scope: string): MessageView {
  if (views.current?.scope !== scope) views.current = { scope, view: newLinkCardView(), rereads: 0 };
  return views.current;
}
const viewFor = (views: MessageViews, scope: string): LinkCardView | null => messageViewFor(views, scope).view;
/** Whether the view of `scope` (still the mounted one) may send another rate-limited re-read. Reads only. */
const rereadsLeft = (views: MessageViews, scope: string) => views.current?.scope === scope && views.current.rereads < LINK_CARD_READ_RETRIES;

/**
 * The one place a message's App link data comes from: read once per message
 * when it is first on screen (`seen`, from the caller's observer of `target`:
 * useMessageLinkCards), then returned per link. The chips and hover cards only
 * read what this returns (through useMessageLinkCards' map); opening a hover
 * card never reads.
 *
 * With the Server's `interactive_link_cards` flag on, the read is the batched
 * v2 read (linkCardRead.ts): one per mounted message view, with its own view id
 * and tickets, taking only its latest request's answer. Links it answers
 * `rate_limited` stay plain and are read again, just those, while the message
 * is on screen: never sooner than their `retry_after`, each wait double the
 * last (60 s at most), LINK_CARD_READ_RETRIES times per view, and never while a
 * read of the whole message is in flight (that read covers them, and a re-read
 * sent meanwhile would be the view's latest request). A batched read with no
 * answer within LINK_CARD_READ_TIMEOUT_MS fails, so nothing waits for it
 * forever. Off, or not known yet, it is the GET.
 *
 * Nothing gives up for good while the message is on screen: a whole read that
 * failed or timed out is read again when the row comes back on screen
 * (LINK_CARD_REENTRY_COOLDOWN_MS), and a hover over a link no read has
 * answered reads that link (LINK_CARD_HOVER_COOLDOWN_MS). A link the App
 * answered plain is final. Every bound stays: Raft's budgets decide per link,
 * the 20 s deadline, one read of the view at a time. Once Raft asks any read
 * to wait (a 429, or rate_limited links), every link-card read of the page
 * waits until then, whichever message it is for (`readHold`).
 *
 * A v2 card comes back with `view`, the message view its hover card buttons act
 * through (linkCardExecute.tsx): read one link again with its ticket, or move the
 * view's request count on when an execute is sent (protocol §7.1). While the
 * message is mounted with the flag on it is registered there, which recovers
 * and follows the viewer's operations on its links.
 *
 * No persistent or cross-viewer cache (in memory, keyed by viewer). Results
 * for another viewer, Server, message or content are aborted or ignored.
 *
 * When the viewer hasn't answered an App yet, the answer carries a prompt for
 * one of its links instead of a card. Within one conversation
 * (`conversationId`: the channel, DM or thread the message is in) an App is
 * asked once, on the first message whose answer comes back with its prompt;
 * the others keep the plain link (linkPreviewConsentStore). An answer updates
 * every message: after Allow, the ones that carried that App's prompt read
 * their links again (its links pending meanwhile); after Don't Allow the
 * links stay plain.
 */
export function useAppLinkPreviews({ messageId, content, conversationId, enabled, target, seen }: {
  messageId: string;
  content: string;
  conversationId: string;
  enabled: boolean;
  target: RefObject<Element | null>;
  /**
   * Whether `target` has been on screen for this viewer, Server, message and
   * content: the caller's IntersectionObserver (useMessageLinkCards, one for
   * the message's App links and its first-party links). The first read waits
   * for it; without IntersectionObserver (old WebViews) it stays false and
   * the links stay plain.
   */
  seen: boolean;
}): AppLinkResults {
  const viewer = useAuthStore((s) => s.user?.id);
  const server = useServerStore((s) => s.current?.id);
  const batched = useServerFeatureFlag(INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY).enabled;
  const locale = htmlLangForLocale(useLocale().locale);
  const active = enabled && !!viewer && !!server && /https:\/\//.test(content);
  // The one host list the message's links are split on (with the Artifacts
  // it names, useMessageLinkCards): a new one when the server's arrives.
  const hosts = useArtifactAppHosts();
  const scope = `${viewer}:${server}:${messageId}:${content}`;
  const mode = batched ? `v2:${locale}` : "v1";
  const views = useRef<MessageView | null>(null);
  const viewerKey = linkPreviewViewerKey(viewer, server);
  // Whose reads the page's hold is: the person's (Raft's read budget is one across their Servers).
  const reader = viewer ?? "";
  const conversationKey = linkPreviewConversationKey(viewerKey, conversationId);
  // A row mounted again starts from its cached answer and keeps it, even if
  // the cache drops it meanwhile.
  const [loaded, setLoaded] = useState<Loaded | null>(() => (active ? cachedAnswer(scope) ?? null : null));
  // A read of the whole message in flight, and how it ends: reads of some
  // links wait for it (Remy, #11003).
  const wholeRead = useRef<{ done: Promise<WholeReadOutcome> } | null>(null);
  const cached = active && loaded?.scope !== scope ? cachedAnswer(scope) : undefined;
  const current = !active ? null : loaded?.scope === scope ? loaded : cached ?? null;
  // What the reads of some links read with, and the answer shown: the latest render's.
  const latest = useRef({ scope, reader, messageId, locale, batched, hosts, shown: current?.scope === scope, answer: current });
  latest.current = { scope, reader, messageId, locale, batched, hosts, shown: current?.scope === scope, answer: current };
  // Reads of some links (a button's re-read, a rate-limited re-read), one at
  // a time and never while a whole read is in flight. They share the view's
  // request count with the whole message (§7.1), so two at once would make
  // the earlier one's answer stale. One dropped anyway (an execute went out
  // meanwhile) is sent again; PARTIAL_READ_TRIES sends in all. A read with no
  // answer within LINK_CARD_READ_TIMEOUT_MS fails, a whole one too, so the
  // wait here ends. Null: still dropped, aborted, or the message changed.
  // While the page's reads are held it waits for that first, then for a whole
  // read, and checks both again until neither waits (Remy): a whole read that
  // started during the hold (after Allow, in another language) goes alone
  // instead of with this one, which would get one answer dropped.
  const partialReads = useRef<Promise<unknown>>(Promise.resolve());
  const readSome = useRef((urls: string[], signal: AbortSignal): Promise<MessageLinksRead | null> => {
    const run = async () => {
      const asked = latest.current;
      for (let tries = 0; tries < PARTIAL_READ_TRIES; tries += 1) {
        while (!signal.aborted && (readHoldLeft(asked.reader) || wholeRead.current)) {
          if (readHoldLeft(asked.reader)) await readHoldPassed(asked.reader, signal);
          else if (wholeRead.current) await wholeRead.current.done;
        }
        if (signal.aborted || latest.current.scope !== asked.scope) return null;
        const read = await readHeld(asked.reader, { messageId: asked.messageId, view: viewFor(views, asked.scope), locale: latest.current.locale, urls }, signal, { deadline: true });
        if (read || signal.aborted) return read;
      }
      return null;
    };
    const result = partialReads.current.then(run, run);
    partialReads.current = result.catch(() => {});
    return result;
  }).current;
  const prompts = useMemo(() => (current ? consentsOf(current.results) : []), [current]);

  // One "status|epoch|asksHere" entry per prompt, so only an answer about
  // this message's Apps re-renders it.
  const answers = useLinkPreviewConsentStore(useShallow((s) => prompts.map((prompt) => {
    const key = linkPreviewAppKey(viewerKey, prompt.app.id);
    return `${s.status[key] ?? ""}|${s.epoch[key] ?? 0}|${s.claims[`${conversationKey}:${prompt.app.id}`] === messageId ? 1 : 0}`;
  })));
  const promptViews = useMemo(() => prompts.map((prompt, index) => {
    const [status, epoch, asksHere] = (answers[index] ?? "||0").split("|");
    return {
      prompt,
      status,
      stale: Number(epoch) > (current?.epochs[linkPreviewAppKey(viewerKey, prompt.app.id)] ?? 0),
      asksHere: asksHere === "1",
    };
  }), [prompts, answers, current, viewerKey]);
  const stale = promptViews.some((view) => view.stale);
  // Another Allow while a reread is on its way starts it again with the new epochs.
  const epochSignature = answers.map((answer) => answer.split("|")[1]).join(",");
  // The whole read this message's answers ask for now (its scope and the
  // consent epochs), and whether one of its waits for the page's reads has
  // lasted LINK_CARD_HELD_PLAIN_AFTER_MS: then its pending chips show plain.
  const heldKey = `${scope}|${epochSignature}`;
  const [heldPlain, setHeldPlain] = useState<string | null>(null);
  const plainWhileHeld = heldPlain === heldKey;
  // Called from a read's wait, LINK_CARD_HELD_PLAIN_AFTER_MS after it began (a timer, never during a render or an effect).
  const markHeldPlain = useCallback(() => setHeldPlain(heldKey), [heldKey]);

  // A row whose whole read failed came back on screen: read it again
  // (`failure`: the failed read this was for; `n` counts, so each return
  // starts the read once).
  const [reentry, setReentry] = useState<{ failure: number; n: number } | null>(null);
  const failure = current?.failure;
  const reentered = failure !== undefined && reentry?.failure === failure;
  const reentries = reentry?.n ?? 0;

  // Read once the message is in view, and again when an App it was asked
  // about has been allowed since (a cached answer included), when it was
  // read the other way: with the GET before the flag was known, or in another
  // language, or when its whole read failed and the row came back on screen.
  // That answer stays until the new one comes.
  const wantsAnswer = active && (current ? stale || current.mode !== mode || reentered : seen);
  useEffect(() => {
    if (!wantsAnswer) return;
    const controller = new AbortController();
    const askedAt = { ...useLinkPreviewConsentStore.getState().epoch };
    const generation = cacheGeneration;
    const cachedBefore = resultCache.get(scope);
    let settle: (outcome: WholeReadOutcome) => void = () => {};
    const inFlight = { done: new Promise<WholeReadOutcome>((resolve) => { settle = resolve; }) };
    wholeRead.current = inFlight;
    const finish = (outcome: WholeReadOutcome) => {
      if (wholeRead.current === inFlight) wholeRead.current = null;
      settle(outcome);
    };
    // When it is sent (not while it waits for the page's reads): the re-entry cooldown counts from then.
    const sent = () => remember(wholeReadSentAt, scope, currentTimeMs(), (value, now) => now - value >= LINK_CARD_REENTRY_COOLDOWN_MS);
    // A wait for the page's reads that lasts LINK_CARD_HELD_PLAIN_AFTER_MS
    // (markHeldPlain): after Allow, the links it would show pending stay plain
    // until it answers. Each wait has its own (a read asked for again after a
    // language change or a dropped answer that waits again included); a read
    // sent at once, with no hold, never starts one.
    const ask = () => {
      // With the flag on, a read that doesn't answer in time fails (and with
      // it what waits for it); with it off, the GET is as it was. Either
      // waits while the page's reads are held (a first read too).
      const read = readHeld(reader, { messageId, view: batched ? viewFor(views, scope) : null, locale }, controller.signal, { deadline: batched, sent, heldLong: markHeldPlain });
      // A later request of the view went out meanwhile (an execute: reads of
      // some links wait for this one), so this answer was dropped (protocol
      // §7.1). Nothing failed: the whole message is asked for again.
      return read.then((answer): Promise<MessageLinksRead | null> | MessageLinksRead | null => (answer || controller.signal.aborted ? answer : ask()));
    };
    void ask()
      .then((read) => {
        if (controller.signal.aborted || !read) return;
        const parsed = read.batched ? readLinkCardAnswer(read.items, read.data) : { results: readAppLinkPreviewAnswer(read.data), retry: null };
        // Ask only on a link that can become the chip: a bare link of this
        // content (the server picks the same ones; this keeps a prompt that
        // could never show from claiming the conversation).
        const bare = new Set(readLinks(content, read.batched, latest.current.hosts));
        const results = new Map([...parsed.results].filter(([url, result]) => result.kind !== "consent" || bare.has(url)));
        const answer: Loaded = { scope, mode, batched: read.batched, results, epochs: askedAt, generation };
        if (parsed.retry) {
          // Its rate_limited links: unread, and read again while the view has re-reads left.
          const at = currentTimeMs() + parsed.retry.backoffMs;
          for (const url of parsed.retry.urls) holdHoverRead(scope, url, at);
          answer.unread = new Set(parsed.retry.urls);
          if (rereadsLeft(views, scope)) answer.retry = parsed.retry;
        }
        useLinkPreviewConsentStore.getState().claimPrompts(conversationKey, consentsOf(answer.results).map((prompt) => prompt.app.id), messageId);
        // An answer with links still to read is not kept yet: mounted again
        // meanwhile, the row reads them all. One asked for before an App was
        // allowed or declined isn't kept either (Remy, #11003), the same check
        // as after the re-reads: the cache dropped what it would carry.
        if (!complete(answer)) resultCache.delete(scope);
        else if (generation === cacheGeneration) cacheAnswer(answer);
        setLoaded(answer);
        finish("answered");
      }).catch(() => {
        // The original link is the fallback. No private response logging. A
        // reread after Allow that fails drops the pending chips, not the
        // links, and the stale entry, so the next mount tries again. A
        // rate-limited re-read waiting for it goes now. The answer is marked
        // failed: the row reads the whole message again when it comes back
        // on screen, and a hover reads a link it left plain (`unread`).
        if (controller.signal.aborted) return;
        finish("failed");
        resultCache.delete(scope);
        const status = useLinkPreviewConsentStore.getState().status;
        const links = readLinks(content, batched, latest.current.hosts);
        wholeReadFailures += 1;
        const failedRead = wholeReadFailures;
        setLoaded((previous) => {
          const base = previous?.scope === scope ? previous : cachedBefore;
          // Nothing shown yet: every link is unread.
          if (!base) return { scope, mode, batched, results: new Map(), epochs: askedAt, generation, unread: new Set(links), failure: failedRead };
          const results = new Map([...base.results].filter(([, result]) => result.kind !== "consent" || status[linkPreviewAppKey(viewerKey, result.app.id)] !== "allowed"));
          // The allowed App's prompts go: their links are unread now.
          const unread = new Set([...base.unread ?? [], ...[...base.results.keys()].filter((url) => !results.has(url))]);
          return { ...base, results, epochs: askedAt, unread, failure: failedRead };
        });
      });
    return () => {
      controller.abort();
      // Cancelled before it answered (the language switched back, the message
      // changed): what waits for it goes on. Not a failure.
      finish("cancelled");
    };
  }, [wantsAnswer, reentries, epochSignature, markHeldPlain, scope, mode, messageId, content, conversationKey, viewerKey, reader, batched, locale]);

  // A row whose whole read failed or timed out: read again when it comes back
  // on screen (it was off screen, then on; the IntersectionObserver's first
  // report only says where it is now), once per return, and not sooner than
  // LINK_CARD_REENTRY_COOLDOWN_MS after the message's last whole read went
  // out: a row back sooner waits on screen for the rest, and leaving again
  // cancels that wait. While the page's reads are held it waits on screen
  // until they aren't. Not while a whole read is in flight (it brings a new
  // answer). A remount reads it anyway, as before.
  useEffect(() => {
    const element = target.current;
    if (failure === undefined || !active || !element || typeof IntersectionObserver === "undefined") return;
    let away = false;
    let cancel: (() => void) | null = null;
    const stopWaiting = () => {
      cancel?.();
      cancel = null;
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      if (!entry.isIntersecting) {
        away = true;
        stopWaiting();
        return;
      }
      if (!away) return;
      away = false;
      stopWaiting();
      const readAgain = () => {
        cancel = null;
        if (wholeRead.current) return;
        setReentry((previous) => ({ failure, n: (previous?.n ?? 0) + 1 }));
      };
      const due = (wholeReadSentAt.get(scope) ?? 0) + LINK_CARD_REENTRY_COOLDOWN_MS - currentTimeMs();
      cancel = afterReadHold(reader, due, readAgain);
    });
    observer.observe(element);
    return () => {
      stopWaiting();
      observer.disconnect();
    };
  }, [failure, scope, reader, active, target]);

  // Read the links answered rate_limited again, just those, while the message
  // is on screen: after the wait (`afterMs`: never sooner than retry_after,
  // doubling from one re-read to the next, 60 s at most), once an
  // IntersectionObserver reports it on screen (at once if it is; off screen
  // the re-read waits, and goes when it is back). LINK_CARD_READ_RETRIES per
  // view at most; the links stay `unread` after that, for a hover. They stay
  // plain links meanwhile, never pending chips. Not while a read of the whole
  // message is in flight (after Allow, in another language): that read covers
  // these links, and a re-read sent meanwhile would be the view's latest
  // request and get its answer dropped. Only while it is in flight, not while
  // it is merely wanted (Remy, #11003): a re-read due meanwhile waits for it.
  // If it answers, its answer brings its own rate_limited links (and this
  // wait is replaced); if it fails or is cancelled, the re-read goes then. A
  // re-read with no answer (it failed, timed out, or an execute dropped it)
  // is followed by the next one, the wait doubled. While the page's reads
  // are held, a due re-read waits until they aren't, then for the screen.
  const retry = current?.retry;
  useEffect(() => {
    const element = target.current;
    if (!retry || !batched || !active || !element || typeof IntersectionObserver === "undefined") return;
    const controller = new AbortController();
    let observer: IntersectionObserver | null = null;
    // The next re-read of `urls`, or none once the view's are spent.
    const next = (urls: string[], retryAfterMs: number) => (rereadsLeft(views, scope) ? nextLinkCardRetry(urls, retry.backoffMs, retryAfterMs) : undefined);
    const cancel = afterReadHold(reader, retry.afterMs, () => {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        void (async () => {
          for (let pending = wholeRead.current; pending; pending = wholeRead.current) {
            if ((await pending.done) === "answered") return;
          }
          if (controller.signal.aborted || !rereadsLeft(views, scope)) return null;
          messageViewFor(views, scope).rereads += 1;
          return readSome(retry.urls, controller.signal);
        })()
          .then((read) => {
            if (controller.signal.aborted || read === undefined) return undefined;
            const again = read?.batched ? readLinkCardAnswer(read.items, null) : null;
            if (again?.retry) {
              const at = currentTimeMs() + again.retry.backoffMs;
              for (const url of again.retry.urls) holdHoverRead(scope, url, at);
            }
            // A later request of the view went out meanwhile (or the session
            // fell back to the GET, which has no re-read): the next one, as
            // another attempt, so this stays bounded.
            return { again, following: !again ? next(retry.urls, 0) : again.retry ? next(again.retry.urls, again.retry.backoffMs) : undefined };
          }, (error: unknown) => {
            // No answer: the links stay plain, and the next re-read waits
            // double, never less than a 429 asked.
            if (controller.signal.aborted) return undefined;
            return { again: null, following: next(retry.urls, retryAfterMsOf(error)) };
          })
          .then((outcome) => {
            if (!outcome) return;
            const { again, following } = outcome;
            setLoaded((previous) => {
              // Only into the answer that asked for it.
              if (previous?.scope !== scope || previous.retry !== retry) return previous;
              if (!again) return { ...previous, retry: following };
              const results = new Map(previous.results);
              const unread = new Set(previous.unread);
              for (const url of retry.urls) {
                const result = again.results.get(url);
                if (result) results.set(url, result);
                // Answered: a card, or the App's plain link (final).
                if (!again.retry?.urls.includes(url)) unread.delete(url);
              }
              const answer = { ...previous, results, unread, retry: following };
              // Every link it waited for has been read: kept like any whole
              // answer (idempotent, so safe in an updater).
              if (complete(answer) && previous.generation === cacheGeneration) cacheAnswer(answer);
              return answer;
            });
          })
          // A handler that threw ends here, not as an unhandled rejection (Remy).
          .catch(() => {});
      });
      observer.observe(element);
    });
    return () => {
      cancel();
      observer?.disconnect();
      controller.abort();
    };
  }, [retry, batched, scope, reader, active, target, readSome]);

  // A hover over a link of the message that no read has answered yet
  // (`unread`: a failed or timed-out read, or rate_limited past the view's
  // re-reads) reads that link, just it (Remy): at most once per
  // LINK_CARD_HOVER_COOLDOWN_MS per link, never before the retry_after Raft
  // last gave it, not while a re-read of it is due or a whole read is in
  // flight. A link the App answered plain (`display: "link"`, or no App) is
  // final and never read here. Batched read only: the GET can't read one link.
  const readOnHover = useRef(async (url: string, signal: AbortSignal) => {
    const asked = latest.current;
    const shown = asked.answer;
    if (!asked.batched || !shown || shown.scope !== asked.scope || !shown.unread?.has(url) || shown.retry?.urls.includes(url) || wholeRead.current) return;
    const now = currentTimeMs();
    if ((hoverNotBefore.get(hoverKey(asked.scope, url)) ?? 0) > now) return;
    holdHoverRead(asked.scope, url, now + LINK_CARD_HOVER_COOLDOWN_MS);
    let read: MessageLinksRead | null;
    try {
      read = await readSome([url], signal);
    } catch (error) {
      holdHoverRead(asked.scope, url, currentTimeMs() + retryAfterMsOf(error));
      return;
    }
    if (!read?.batched || signal.aborted || latest.current.scope !== asked.scope) return;
    const again = readLinkCardAnswer(read.items, null);
    // Still rate_limited: it stays unread, not before its retry_after.
    if (again.retry) {
      holdHoverRead(asked.scope, url, currentTimeMs() + again.retry.backoffMs);
      return;
    }
    const result = again.results.get(url);
    setLoaded((previous) => {
      if (previous?.scope !== asked.scope || !previous.unread?.has(url)) return previous;
      const results = new Map(previous.results);
      // No result: the App answered it plain, which is final.
      if (result) results.set(url, result);
      const unread = new Set(previous.unread);
      unread.delete(url);
      const answer = { ...previous, results, unread };
      if (complete(answer) && previous.generation === cacheGeneration) cacheAnswer(answer);
      return answer;
    });
  }).current;
  useEffect(() => {
    const element = target.current;
    if (!active || !batched || !element) return;
    const controller = new AbortController();
    const over = (event: Event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      // The author's link (a chip is answered already), in this message.
      if (!link || link.hasAttribute("data-app-link-chip") || !element.contains(link)) return;
      const url = appLinkResultKey(link.getAttribute("href") ?? "");
      if (url) void readOnHover(url, controller.signal);
    };
    element.addEventListener("mouseover", over);
    return () => {
      element.removeEventListener("mouseover", over);
      controller.abort();
    };
  }, [active, batched, target, readOnHover]);

  // Aborted when the message unmounts: a button's re-read still waiting (its
  // turn in the view, or for the page's reads) is not sent after that.
  const mounted = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);

  // The message view the hover card buttons act through. Stable for the
  // message; what it reads with is the latest render's. A button's re-read
  // (Refresh, or an old handle's) waits while the page's reads are held: the
  // press shows Working… meanwhile and reads as soon as Raft allows.
  const messageView = useMemo<LinkCardMessageView>(() => ({
    key: `${viewerKey}|${messageId}`,
    messageId,
    reread: async (url: string): Promise<LinkCardReread> => {
      const asked = latest.current;
      // Nothing on screen yet: its first read comes once it is in view.
      if (!asked.shown) return { kind: "unshown" };
      if (!asked.batched || !viewFor(views, asked.scope)) return { kind: "failed" };
      let read: MessageLinksRead | null;
      try {
        read = await readSome([url], mounted.current?.signal ?? new AbortController().signal);
      } catch {
        return { kind: "failed" };
      }
      if (!read?.batched || latest.current.scope !== asked.scope) return { kind: "superseded" };
      const again = readLinkCardAnswer(read.items, null);
      if (again.retry?.urls.includes(url)) return { kind: "failed" }; // rate_limited: the card stays as it was
      const result = again.results.get(url) ?? null;
      setLoaded((previous) => {
        const base = previous?.scope === asked.scope ? previous : resultCache.get(asked.scope);
        if (!base) return previous;
        const results = new Map(base.results);
        // No result: the link is the author's link now (F11).
        if (result) results.set(url, result);
        else results.delete(url);
        const answer = { ...base, results };
        if (complete(answer) && base.generation === cacheGeneration) cacheAnswer(answer);
        return answer;
      });
      return { kind: "read", result };
    },
    beginExecute: () => {
      const view = views.current?.scope === latest.current.scope ? views.current.view : null;
      if (view) bumpLinkCardViewSeq(view);
    },
  }), [viewerKey, messageId, readSome]);

  // While mounted with the batched read, the message is registered with the
  // card actions: they recover the viewer's operations on its links (local
  // records, then status) and follow them while it is on screen.
  // Status toasts that no press asked for speak the UI's language.
  const intlContext = useContext(IntlContext);
  const intl = useRef(intlContext);
  intl.current = intlContext;
  // Split again when the host list arrives; the same links keep their array,
  // so only a message whose read changed registers again.
  const readNow = useMemo(() => readLinks(content, true, hosts), [content, hosts]);
  const registered = useRef(readNow);
  if (registered.current !== readNow && !sameLinks(registered.current, readNow)) registered.current = readNow;
  const links = registered.current;
  useEffect(() => {
    if (!active || !batched) return;
    return registerLinkCardMessageView({ viewerKey, messageId, urls: links, view: messageView, format: () => intl.current?.formatMessage ?? null });
  }, [active, batched, viewerKey, messageId, links, messageView]);

  return useMemo(() => {
    if (!current) return NO_RESULTS;
    const withViews = (results: AppLinkResults): AppLinkResults => {
      if (![...results.values()].some((result) => result.kind === "card" && result.cardV2)) return results;
      return new Map([...results].map(([url, result]) => [url, result.kind === "card" && result.cardV2 ? { ...result, view: messageView } : result]));
    };
    if (!promptViews.length) return withViews(current.results);
    const results = new Map(current.results);
    const links = stale ? readLinks(content, current.batched, hosts) : [];
    for (const { prompt, status, stale: allowedSince, asksHere } of promptViews) {
      results.delete(prompt.url);
      if (!asksHere) continue;
      if (allowedSince) {
        // Its links are read again: each one not already a card waits as a
        // pending chip. Once that read has waited for the page's reads past
        // LINK_CARD_HELD_PLAIN_AFTER_MS they are plain links until it answers
        // (a card stays a card either way).
        if (plainWhileHeld) continue;
        const origin = publicPreviewUrl(prompt.url)?.origin;
        for (const url of [prompt.url, ...links]) {
          if (publicPreviewUrl(url)?.origin === origin && !results.has(url)) results.set(url, { kind: "pending", url });
        }
        continue;
      }
      if (status !== "declined" && status !== "unavailable") results.set(prompt.url, prompt);
    }
    return withViews(results);
  }, [current, promptViews, stale, plainWhileHeld, content, hosts, messageView]);
}
