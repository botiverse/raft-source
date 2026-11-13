// Search (S9): Artifacts' own index and what a list with `query` reads of it.
//
// Title only, by product decision (xxchan, 2026-10-23); content, paths,
// description and name are not searched for now. One `app_artifacts.search`
// row per Artifact holds its title's index-side tokens (buildSearchIndexText:
// jieba `cut_for_search`, so 财务 finds 财务报告); queries are tokenized on
// the query side (tokenizeSearchText: `cut`), ASCII words of three or more
// characters also matching as prefixes.
//
// The row is written in the same transaction as what sets the title, under
// the item's row lock: a publish (publish.ts) and a rename or metadata edit
// (indexArtifactSearch, the same call). A title is at most 300 characters,
// so tokenizing it inside the transaction is cheap. Deleting an item removes
// the row by cascade; a soft-deleted or revoked item is never listed anyway
// (visibleArtifactsSql).
//
// One search, three callers: the agent API's list with `query` (routes.ts) and
// core's `GET /api/search` (webSearch.ts, the registration's `search`) both
// run prepareArtifactSearch, each with its visibility condition, and page
// with the same cursor; the Artifacts page's All tab (webDashboard.ts) takes
// the same words as one condition (`titleMatch`) on a list ordered by update
// time instead of rank.
import { createHash } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS, type AgentApiArtifactSearchMatch } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { buildSearchIndexText, tokenizeSearchText } from "../../platform/searchTokenizer";
import { ARTIFACT_CURSOR_ID } from "./apiCommon";
import { artifactItems, artifactSearch, type ArtifactItemRow } from "./schema";

/**
 * Write (or replace) an item's row for its current title, inside the
 * caller's transaction: every write that sets the title calls it.
 */
export async function indexArtifactSearch(
  executor: DatabaseExecutor,
  item: Pick<ArtifactItemRow, "id" | "serverId" | "title">,
): Promise<void> {
  const values = { serverId: item.serverId, titleTokens: buildSearchIndexText(item.title) };
  await executor.insert(artifactSearch).values({ itemId: item.id, ...values })
    .onConflictDoUpdate({ target: artifactSearch.itemId, set: { ...values, updatedAt: new Date() } });
}

// ---- the query -------------------------------------------------------------------

/** A query word, and whether it also matches as a prefix (ASCII letters and digits, three or more). */
export interface QueryToken {
  text: string;
  prefix: boolean;
}

const PREFIX_TOKEN = /^[a-z0-9]{3,}$/;

/** The query's distinct words (tokenizeSearchText's), each marked whether it matches as a prefix. */
export function queryTokensOf(tokens: readonly string[]): QueryToken[] {
  return [...new Set(tokens)].map((text) => ({ text, prefix: PREFIX_TOKEN.test(text) }));
}

/**
 * The tsquery every word must match (AND). A prefix word is `word:*` through
 * to_tsquery; it is only ever [a-z0-9]{3,} (PREFIX_TOKEN), so no tsquery
 * syntax can come from the user's text, and it is a bound parameter. Any
 * other word goes through plainto_tsquery, which reads no syntax at all.
 */
export function searchTsQuery(tokens: readonly QueryToken[]): SQL {
  const parts = tokens.map((token) => (token.prefix
    ? sql`to_tsquery('simple', ${`${token.text}:*`})`
    : sql`plainto_tsquery('simple', ${token.text})`));
  return sql`(${sql.join(parts, sql` && `)})`;
}

// ---- matches -------------------------------------------------------------------

type Highlight = { start: number; length: number };

const ASCII_WORD = /^[a-z0-9]$/i;

/** Each code point folded to lower case when that stays one code point, so offsets are unchanged. */
function fold(points: readonly string[]): string[] {
  return points.map((point) => {
    const lower = point.toLowerCase();
    return Array.from(lower).length === 1 ? lower : point;
  });
}

/**
 * Where the query's words occur in `points` (code points), merged and in
 * order. A word that starts or ends with an ASCII letter or digit matches
 * only at a word boundary there ("art" is not found in "start"); a prefix
 * word may end inside a word and is highlighted to that word's end ("plan"
 * in "Planning").
 */
function highlightsIn(points: readonly string[], tokens: readonly QueryToken[]): Highlight[] {
  const folded = fold(points);
  const found: Highlight[] = [];
  for (const token of tokens) {
    const chars = Array.from(token.text);
    const startsWord = ASCII_WORD.test(chars[0]!);
    const endsWord = ASCII_WORD.test(chars[chars.length - 1]!);
    for (let at = 0; at + chars.length <= folded.length; at += 1) {
      let same = true;
      for (let k = 0; k < chars.length && same; k += 1) same = folded[at + k] === chars[k];
      if (!same) continue;
      if (startsWord && at > 0 && ASCII_WORD.test(folded[at - 1]!)) continue;
      let end = at + chars.length;
      if (token.prefix) {
        while (end < folded.length && ASCII_WORD.test(folded[end]!)) end += 1;
      } else if (endsWord && end < folded.length && ASCII_WORD.test(folded[end]!)) continue;
      found.push({ start: at, length: end - at });
    }
  }
  found.sort((a, b) => a.start - b.start || b.length - a.length);
  const merged: Highlight[] = [];
  for (const next of found) {
    const last = merged[merged.length - 1];
    if (last && next.start <= last.start + last.length) {
      last.length = Math.max(last.length, next.start + next.length - last.start);
    } else merged.push({ ...next });
  }
  return merged;
}

/**
 * The snippet of `text` around its first match (whitespace collapsed), at
 * most AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS code points, starting a little
 * before the match; null when no word occurs in it.
 */
export function snippetOf(text: string, tokens: readonly QueryToken[]): { snippet: string; highlights: Highlight[] } | null {
  const points = Array.from(text.replace(/\s+/g, " ").trim());
  const all = highlightsIn(points, tokens);
  if (all.length === 0) return null;
  const width = AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS;
  const start = Math.max(0, Math.min(all[0]!.start - Math.floor(width / 4), points.length - width));
  const end = Math.min(points.length, start + width);
  const highlights = all
    .filter((highlight) => highlight.start < end)
    .map((highlight) => ({ start: highlight.start - start, length: Math.min(highlight.length, end - highlight.start) }));
  return { snippet: points.slice(start, end).join(""), highlights };
}

/**
 * Where a query matched one Artifact: its title (the only field searched).
 * Matched against the title as written, so a hit the index found only
 * through the tokenizer's normalization (Markdown marks dropped, for
 * example) shows no match.
 */
export function matchesOf(item: Pick<ArtifactItemRow, "title">, tokens: readonly QueryToken[]): AgentApiArtifactSearchMatch[] {
  const found = snippetOf(item.title, tokens);
  return found ? [{ field: "title", ...found }] : [];
}

// ---- the cursor ------------------------------------------------------------------

/**
 * A list cursor: the last row's place in the order. Without a query
 * `[updatedAt, id]`; with one `[query digest, rank, updatedAt, id]`, so a
 * cursor only continues the query it came from (another query's, or a plain
 * list's, is an invalid cursor). The rank is ts_rank_cd's float4 read as
 * float8 and compared as float8, so it survives JSON exactly; a cursor's
 * rank must be a float4 value (Math.fround) and not negative, updatedAt
 * within years 1 to 9999, and the id an Artifact id (ARTIFACT_CURSOR_ID).
 * The digest is not a secret: a forged cursor that passes only skips within
 * the caller's own visible results.
 */
export type ListCursor = { updatedAt: Date; id: string; search: { digest: string; rank: number } | null };

/** The query's tokens, as a cursor names them. */
const queryDigest = (tokens: readonly string[]): string => createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);

export function encodeListCursor(item: Pick<ArtifactItemRow, "updatedAt" | "id">, search: ListCursor["search"]): string {
  const place = [item.updatedAt.toISOString(), item.id];
  return Buffer.from(JSON.stringify(search ? [search.digest, search.rank, ...place] : place)).toString("base64url");
}

/** The cursor, or null when it isn't one of this list's (`digest`: the query's, null for a plain list). */
export function decodeListCursor(cursor: string, digest: string | null): ListCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value)) return null;
    let search: ListCursor["search"] = null;
    let place: unknown[] = value;
    if (digest !== null) {
      // A real rank is a float4 value (ts_rank_cd), never negative.
      if (value.length !== 4 || value[0] !== digest || typeof value[1] !== "number" || value[1] < 0 || Math.fround(value[1]) !== value[1]) return null;
      search = { digest, rank: value[1] };
      place = value.slice(2);
    }
    if (place.length !== 2 || typeof place[0] !== "string" || typeof place[1] !== "string" || !ARTIFACT_CURSOR_ID.test(place[1])) return null;
    const updatedAt = new Date(place[0]);
    if (Number.isNaN(updatedAt.getTime())) return null;
    const year = updatedAt.getUTCFullYear();
    return year >= 1 && year <= 9999 ? { updatedAt, id: place[1], search } : null;
  } catch {
    return null;
  }
}

/** Ordered at millisecond precision, the precision a cursor carries. */
export const updatedMs = sql`date_trunc('milliseconds', ${artifactItems.updatedAt})`;

// ---- the search ------------------------------------------------------------------

/** A page of a search: the items, most relevant first, where each matched, and the cursor of the next page. */
export interface ArtifactSearchPage {
  items: ArtifactItemRow[];
  matches: AgentApiArtifactSearchMatch[][];
  nextCursor: string | null;
}

/** A query, tokenized once: its cursors' digest, and its search. */
export interface PreparedArtifactSearch {
  digest: string;
  /**
   * The same rule as `run` (every word in the title's index row, searchTsQuery)
   * as one condition on app_artifacts.items, for a list in an order of its
   * own (the All tab's, by update time): the caller puts it in the statement
   * with its visibility, order and LIMIT. Null when the query has no words in
   * it (only punctuation): it matches nothing.
   */
  titleMatch: SQL | null;
  /**
   * One page: the items `visible` lets through (a condition on
   * app_artifacts.items, in this same statement as the rank order and
   * LIMIT, never a filter after it) whose title has every word, and
   * `conditions` too; after `cursor` (decodeListCursor with this digest).
   */
  run(input: { visible: SQL; conditions?: readonly SQL[]; cursor: ListCursor | null; limit: number; executor?: DatabaseExecutor }): Promise<ArtifactSearchPage>;
}

/**
 * The search of Artifacts' index for `query` (the query side's words,
 * searchTokenizer). Every word must occur in the title (searchTsQuery ANDs
 * them): one fixed condition, so pages of one query never change their rule
 * midway. Ordered by ts_rank_cd, then updatedAt (milliseconds) and id, all
 * descending, as one row comparison against the cursor. A query with no
 * words in it (only punctuation) matches nothing.
 */
export function prepareArtifactSearch(query: string): PreparedArtifactSearch {
  const tokens = tokenizeSearchText(query);
  const digest = queryDigest(tokens);
  const queryTokens = queryTokensOf(tokens);
  const titleMatch = queryTokens.length === 0 ? null : sql`EXISTS (SELECT 1 FROM ${artifactSearch}
    WHERE ${artifactSearch.itemId} = ${artifactItems.id}
      AND ${artifactSearch.serverId} = ${artifactItems.serverId}
      AND ${artifactSearch.searchVector} @@ ${searchTsQuery(queryTokens)})`;
  return {
    digest,
    titleMatch,
    async run({ visible, conditions = [], cursor, limit, executor = getDb() }) {
      if (queryTokens.length === 0) return { items: [], matches: [], nextCursor: null };
      const tsQuery = searchTsQuery(queryTokens);
      const rank = sql<number>`ts_rank_cd(${artifactSearch.searchVector}, ${tsQuery})::float8`;
      const where: SQL[] = [visible, ...conditions, sql`${artifactSearch.searchVector} @@ ${tsQuery}`];
      if (cursor?.search) {
        where.push(sql`(${rank}, ${updatedMs}, ${artifactItems.id}) < (${cursor.search.rank}::float8, ${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id})`);
      }
      const rows = await executor.select({ item: artifactItems, rank }).from(artifactItems)
        .innerJoin(artifactSearch, and(
          eq(artifactSearch.itemId, artifactItems.id),
          eq(artifactSearch.serverId, artifactItems.serverId),
        ))
        .where(and(...where))
        .orderBy(desc(rank), desc(updatedMs), desc(artifactItems.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => row.item),
        matches: page.map((row) => matchesOf(row.item, queryTokens)),
        nextCursor: rows.length > limit && last ? encodeListCursor(last.item, { digest, rank: Number(last.rank) }) : null,
      };
    },
  };
}
