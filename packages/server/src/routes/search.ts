// Core's search across first-party apps (first-party app mechanism §五):
// `GET /api/search?q=&app=&cursor=&limit=` (contract: packages/shared
// webSearchContract.ts), mounted by app.ts behind requireAuth,
// requireVerified and requireServer (the reader is req.userId in
// req.serverId). Core knows no app: it asks every registered app that has a
// `search` (apps/firstPartyApps.ts) and answers one group per app.
//
// In order:
// 1. the request: `q` trimmed, 1 to WEB_SEARCH_QUERY_MAX_CHARS code points
//    (400 INVALID_QUERY); `limit` 1 to WEB_SEARCH_MAX_LIMIT, and `cursor` only
//    with `app` (400 INVALID_REQUEST);
// 2. the apps: those with a search whose flag is on for the reader's server
//    (one batched flag evaluation); with `app`, that one only, else 404
//    APP_NOT_FOUND (unknown and switched off answer alike);
// 3. the reader's visible homes, read once (platform/visibility
//    visibleHomes, with each searching app's flag); each app gets them as a
//    condition on its own home columns, which names the reader's server, so
//    only that server is searched, but for objects homed in a joint the
//    reader sees, of the joint's servers that have the app on; an app
//    filters visibility in its own query;
// 4. each app's search, all at once, each in a read-only transaction of its
//    own under `SET LOCAL statement_timeout` (APP_SEARCH_STATEMENT_TIMEOUT_MS,
//    a limit on each statement, not on the app's whole search): a statement
//    cut off answers that app's group `{ error: "timeout" }`, any other
//    failure `{ error: "failed" }`; the other groups are answered regardless.
//    An app's refusal of the cursor is 400 INVALID_CURSOR.
//
// Core groups (`channels`, `people`: services/coreSearchService.ts; contract
// docs/contracts/web-search.md) are core's own, not apps: no flag, opt-in.
// `include=channels,people` (without `app`) adds their first pages after the
// app groups; `app=channels` / `app=people` answers that group alone, paged
// with its cursor. Without either, the answer is exactly the app groups, as
// before. Each core group runs like an app's search: its own read-only
// transaction under the same statement timeout, `{ error }` on failure. A
// core group's page adds `total` (every match, for "Show all N").
//
// Costs to watch (Tenny): each app's search holds a primary connection for
// its whole run, so one request takes as many as there are apps searching;
// with more apps, cap how many run at once or run them on one connection in
// turn. Searches run on the primary: fine for Artifacts' indexed title
// search; an app that searches content should move to a read replica.
// Every answer is the reader's own: `private, no-store`.
import { sql } from "drizzle-orm";
import { Router, type Response, type Router as RouterType } from "express";
import {
  asSearchCursor,
  asServerId,
  isWebSearchCoreGroupId,
  WEB_SEARCH_CORE_DEFAULT_LIMIT,
  WEB_SEARCH_CORE_GROUPS,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  type SearchCursor,
  type TraceAttributes,
  type WebSearchCoreGroup,
  type WebSearchCoreGroupId,
  type WebSearchErrorCode,
  type WebSearchGroup,
  type WebSearchResponse,
} from "@botiverse/raft-shared";
import { firstPartyApps } from "../apps/firstPartyApps";
import { getDb } from "../db/index";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import type { AppSearchInput, AppSearchPage, FirstPartyApp } from "../platform/apps";
import { visibleHomes } from "../platform/visibility";
import { CORE_SEARCHES, type CoreSearchInput, type CoreSearchPage } from "../services/coreSearchService";
import { evaluateFeatureFlags } from "../services/featureFlagService";
import { queryLengthBucket, queryScript } from "../tracing/messageSearchTrace";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { safeAddTraceEvent } from "../tracing/semanticTrace";

/**
 * How long one statement of an app's search may run (Postgres cancels it,
 * SQLSTATE 57014): long enough for an index search or one of its card reads,
 * short enough that a slow app holds the page for seconds, not the primary's
 * 60. Per statement: an app's search of a few statements may take a few times
 * this.
 */
export const APP_SEARCH_STATEMENT_TIMEOUT_MS = 2_500;

export const searchRouter: RouterType = Router();

function refuse(res: Response, status: number, code: WebSearchErrorCode, error: string): void {
  setRequestTraceErrorCode(res, code);
  res.status(status).json({ error, code });
}

/** A statement Postgres cut off at its statement_timeout (57014), anywhere on the cause chain (Drizzle wraps the driver's error). */
function isStatementTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type AppSearchAnswer = AppSearchPage | { kind: "error"; error: "timeout" | "failed" };

/**
 * One app's group, as a trace event (`app_search.group.finished`): which app,
 * how it ended, how many items and whether there is more, and how long the
 * app's search took. Shape only, never the query or the items. Without this
 * the request span showed only that `/api/search` answered, not which group
 * timed out or came back empty.
 */
export function appSearchGroupTraceAttrs(appId: string, answer: AppSearchAnswer, durationMs: number): TraceAttributes {
  const base = { app: appId, duration_ms: Math.round(durationMs) };
  if (answer.kind === "page") {
    return { ...base, outcome: answer.items.length === 0 ? "empty" : "ok", item_count: answer.items.length, has_more: answer.nextCursor !== null };
  }
  if (answer.kind === "invalid_cursor") return { ...base, outcome: "invalid_cursor" };
  return { ...base, outcome: answer.error };
}

/** One app's search, in a read-only transaction of its own under the statement timeout. Exported for search.realPg.test.ts. */
export async function searchApp(app: FirstPartyApp, search: NonNullable<FirstPartyApp["search"]>, input: Omit<AppSearchInput, "executor">): Promise<AppSearchAnswer> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms'`));
      return search({ ...input, executor: tx });
    }, { accessMode: "read only" });
  } catch (error) {
    if (isStatementTimeout(error)) {
      console.warn(`api.search.${app.id} timed out`, { timeoutMs: APP_SEARCH_STATEMENT_TIMEOUT_MS });
      return { kind: "error", error: "timeout" };
    }
    console.error(`api.search.${app.id} failed`, serializeErrorForLog(error));
    return { kind: "error", error: "failed" };
  }
}

type CoreSearchAnswer = CoreSearchPage<unknown> | { kind: "error"; error: "timeout" | "failed" };

/** One core group's search, as searchApp runs an app's: a read-only transaction of its own under the statement timeout. */
export async function searchCoreGroup(group: WebSearchCoreGroupId, input: CoreSearchInput): Promise<CoreSearchAnswer> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms'`));
      return CORE_SEARCHES[group](input) as Promise<CoreSearchPage<unknown>>;
    }, { accessMode: "read only" });
  } catch (error) {
    if (isStatementTimeout(error)) {
      console.warn(`api.search.${group} timed out`, { timeoutMs: APP_SEARCH_STATEMENT_TIMEOUT_MS });
      return { kind: "error", error: "timeout" };
    }
    console.error(`api.search.${group} failed`, serializeErrorForLog(error));
    return { kind: "error", error: "failed" };
  }
}

/** `include` as asked: absent → none; else a comma list of core group ids (in the contract's order), or null. */
function includeOf(value: unknown): WebSearchCoreGroupId[] | null {
  if (value === undefined) return [];
  if (typeof value !== "string") return null;
  const asked = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (asked.length === 0 || !asked.every(isWebSearchCoreGroupId)) return null;
  return WEB_SEARCH_CORE_GROUPS.filter((group) => asked.includes(group));
}

/** `limit` as asked: absent → `fallback`; else a whole number from 1 to the max, or null. */
function limitOf(value: unknown, fallback: number = WEB_SEARCH_DEFAULT_LIMIT): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= WEB_SEARCH_MAX_LIMIT ? limit : null;
}

async function runCoreGroup(group: WebSearchCoreGroupId, input: CoreSearchInput): Promise<CoreSearchAnswer> {
  const startedAt = performance.now();
  const answer = await searchCoreGroup(group, input);
  safeAddTraceEvent("app_search.group.finished", () => appSearchGroupTraceAttrs(group, answer.kind === "page" ? { kind: "page", items: answer.items as never[], nextCursor: answer.nextCursor } : answer, performance.now() - startedAt));
  return answer;
}

function coreGroupOf(group: WebSearchCoreGroupId, answer: Exclude<CoreSearchAnswer, { kind: "invalid_cursor" }>): WebSearchCoreGroup {
  // The group's items are its own type (WebSearchItemsByCoreGroup), by its id.
  return (answer.kind === "page"
    ? { app: group, items: answer.items, nextCursor: answer.nextCursor, total: answer.total }
    : { app: group, error: answer.error }) as WebSearchCoreGroup;
}

searchRouter.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length === 0) {
      refuse(res, 400, "INVALID_QUERY", "q is required: the words to search for");
      return;
    }
    if (Array.from(q).length > WEB_SEARCH_QUERY_MAX_CHARS) {
      refuse(res, 400, "INVALID_QUERY", `q is longer than ${WEB_SEARCH_QUERY_MAX_CHARS} characters: use fewer words`);
      return;
    }
    const limit = limitOf(req.query.limit);
    const coreLimit = limitOf(req.query.limit, WEB_SEARCH_CORE_DEFAULT_LIMIT);
    if (limit === null || coreLimit === null) {
      refuse(res, 400, "INVALID_REQUEST", `limit is a whole number from 1 to ${WEB_SEARCH_MAX_LIMIT}`);
      return;
    }
    const { app: appParam, cursor: cursorParam } = req.query;
    if (appParam !== undefined && typeof appParam !== "string") {
      refuse(res, 400, "INVALID_REQUEST", "app is one app's id");
      return;
    }
    let cursor: SearchCursor | null = null;
    if (cursorParam !== undefined) {
      if (typeof cursorParam !== "string" || cursorParam.length === 0 || appParam === undefined) {
        refuse(res, 400, "INVALID_REQUEST", "cursor continues one app's group: send it with that app");
        return;
      }
      cursor = asSearchCursor(cursorParam);
    }
    const include = includeOf(req.query.include);
    if (include === null || (include.length > 0 && appParam !== undefined)) {
      refuse(res, 400, "INVALID_REQUEST", `include is a comma list of ${WEB_SEARCH_CORE_GROUPS.join(", ")}, without app`);
      return;
    }

    const serverId = asServerId(req.serverId!);
    const viewer = { userId: req.userId!, serverId };
    if (appParam !== undefined && isWebSearchCoreGroupId(appParam)) {
      // One core group alone: its page, or the next one with its cursor.
      const answer = await runCoreGroup(appParam, { viewer, q, limit: coreLimit, cursor });
      if (answer.kind === "invalid_cursor") {
        refuse(res, 400, "INVALID_CURSOR", "invalid cursor: a cursor only continues the search it came from; drop it to start over");
        return;
      }
      const body: WebSearchResponse = { groups: [coreGroupOf(appParam, answer)] };
      res.json(body);
      return;
    }

    const searchable = firstPartyApps().flatMap((app) => (app.search && (appParam === undefined || app.id === appParam) ? [{ app, search: app.search }] : []));
    const flags = searchable.length > 0 ? await evaluateFeatureFlags(searchable.map(({ app }) => ({ key: app.flag, serverId }))) : [];
    const enabled = searchable.filter((_, index) => flags[index]?.enabled === true);
    if (appParam !== undefined && enabled.length === 0) {
      refuse(res, 404, "APP_NOT_FOUND", "no app by that id searches here");
      return;
    }

    // Each app's condition lets another server's object in a joint through only while that server has the app on.
    const homes = enabled.length > 0 ? await visibleHomes({ type: "user", id: viewer.userId, serverId }, { appFlags: enabled.map(({ app }) => app.flag) }) : null;
    safeAddTraceEvent("app_search.request.accepted", () => ({
      apps_count: enabled.length,
      core_groups_count: include.length,
      app_param_present: appParam !== undefined,
      cursor_present: cursor !== null,
      limit,
      query_length_bucket: queryLengthBucket(q),
      query_script: queryScript(q),
    }));
    // fanout-ok: one search per core group asked for (at most WEB_SEARCH_CORE_GROUPS)
    const coreAnswers = Promise.all(include.map((group) => runCoreGroup(group, { viewer, q, limit: coreLimit, cursor: null })));
    // fanout-ok: one search per enabled first-party app with a search hook (a fixed registry), or the one asked for
    const answers = await Promise.all(enabled.map(async ({ app, search }) => {
      const startedAt = performance.now();
      const answer = await searchApp(app, search, {
        viewer,
        q,
        cursor,
        limit,
        visibleHomesSql: (columns) => homes!.sql(columns, { appFlag: app.flag }),
      });
      safeAddTraceEvent("app_search.group.finished", () => appSearchGroupTraceAttrs(app.id, answer, performance.now() - startedAt));
      return answer;
    }));
    const groups: WebSearchResponse["groups"] = [];
    for (const [index, answer] of answers.entries()) {
      const id = enabled[index]!.app.id;
      if (answer.kind === "invalid_cursor") {
        refuse(res, 400, "INVALID_CURSOR", "invalid cursor: a cursor only continues the search it came from; drop it to start over");
        return;
      }
      // The app's items are its own type, declared in shared by its id (WebSearchItemsByApp).
      groups.push((answer.kind === "page" ? { app: id, items: answer.items, nextCursor: answer.nextCursor } : { app: id, error: answer.error }) as WebSearchGroup);
    }
    for (const [index, answer] of (await coreAnswers).entries()) {
      // A first page has no cursor to refuse.
      if (answer.kind !== "invalid_cursor") groups.push(coreGroupOf(include[index]!, answer));
    }
    const body: WebSearchResponse = { groups };
    res.json(body);
  } catch (error) {
    console.error("api.search failed", serializeErrorForLog(error));
    if (!res.headersSent) res.status(500).json({ error: "Failed to search" });
  }
});
