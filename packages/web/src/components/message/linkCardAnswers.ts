import { z } from "zod";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { LinkCardReadAnswerItem } from "@botiverse/raft-shared/src/appLinkPreview";
import { appLinkPreviewListResponseSchema, publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
import { parseRetryAfterMs } from "../../api/overloadRetry";
import { appLinkResultOfItem } from "./linkCardItems";
import type { AppLinkResult, AppLinkResults } from "./useAppLinkPreviews";

// A read's answer as per-link results, and when to read its rate_limited
// links again (split out of useAppLinkPreviews.ts, which reads with them).
// docs/development/app-link-previews.md, "Web display".

/** The key a message link is looked up by: its WHATWG href, for previewable links only. */
export function appLinkResultKey(url: string): string | null {
  return publicPreviewUrl(url)?.href ?? null;
}

// `prompts` is read on its own: a prompt the client can't read is dropped
// without hiding the previews next to it (and the reverse).
export const promptListSchema = z.array(z.object({
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
export const jitterMs = () => Math.floor(retryRandom() * RETRY_JITTER_MS);
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
export function retryAfterMsOf(error: unknown): number {
  const tooMany = tooManyRequestsSchema.safeParse(error);
  const waitMs = tooMany.success ? parseRetryAfterMs(tooMany.data.response.headers, currentTimeMs()) : null;
  return waitMs ? Math.min(RETRY_AFTER_MAX_MS, waitMs) : 0;
}

/** The wait rate_limited links ask for: their longest `retry_after` (seconds), clamped to 1-60 s, in ms. */
export const rateLimitedBackoffMs = (retryAfters: number[]) => Math.min(60, Math.max(1, ...retryAfters)) * 1000;

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
    const result = appLinkResultOfItem(item, key, item.app.reviewed === false ? { ...app, reviewed: false } : app);
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
