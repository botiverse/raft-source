import assert from "node:assert/strict";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { asServerId } from "@botiverse/raft-shared";
import type { VisibleRoots } from "./visibilityService";
import {
  buildVisibleConversationChannelsSql,
  buildVisibleConversationRowCheckSql,
  buildMessageSearchBreadthProbeSql,
  buildMessageSearchTextMatchProbeSql,
  buildSearchCandidateCtes,
  buildSnippet,
  classifyMessageSearchBreadth,
  classifyMessageSearchTextMatchBreadth,
  MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
  readMessageSearchEstimatedCandidateRows,
  chooseMessageSearchRecentPlan,
  MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT,
  SEARCH_SNIPPET_WIDTH_BEFORE_HIT,
  SEARCH_SNIPPET_WIDTH_AFTER_HIT,
  searchSnippetCharWidth,
} from "./searchService";
import { buildSearchText, preprocessSearchContent, tokenizeSearchText } from "./searchTokenizer";

function normalizeSql(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

test("preprocessSearchContent preserves markdown link text and inline code while removing URLs", () => {
  const input = "参考 [Neon 文档](https://neon.com/docs) 然后运行 `npm install express`";
  const output = preprocessSearchContent(input);
  assert.match(output, /Neon 文档/);
  assert.match(output, /npm install express/);
  assert.doesNotMatch(output, /https:\/\/neon\.com/);
});

test("tokenizeSearchText keeps English words intact while segmenting Chinese", () => {
  const tokens = tokenizeSearchText("部署到staging环境并执行 npm install express");
  assert.deepEqual(tokens, ["部署", "到", "staging", "环境", "并", "执行", "npm", "install", "express"]);
});

test("buildSearchText removes markdown noise from rich text", () => {
  const searchText = buildSearchText("**部署方案** 已写好，见 `config.ts` 和 https://example.com");
  assert.equal(searchText, "部署 方案 已写 好 见 config ts 和");
});

const VISIBLE_ROOTS: VisibleRoots = {
  serverId: asServerId("00000000-0000-4000-8000-000000000001"),
  roots: [
    { id: "00000000-0000-4000-8000-000000000011", type: "channel", name: "general", archivedAt: null },
    { id: "00000000-0000-4000-8000-000000000012", type: "joint", name: "shared", archivedAt: null },
  ],
  parentlessThreadIds: ["00000000-0000-4000-8000-000000000013"],
  jointStorageByLocalId: new Map([["00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000014"]]),
};

function snippetWidth(text: string): number {
  let width = 0;
  for (const char of text) width += searchSnippetCharWidth(char.codePointAt(0) ?? 0);
  return width;
}

test("snippet of a long Chinese message keeps 12 characters before a late hit", () => {
  const before = "我们今天下午讨论了搜索结果的展示问题大家觉得中文长消息的命中位置经常被截断在省略号后面所以需要重新设计片段的截取方式让命中词出现在第一行里面这样用户在手机上也能直接看到";
  const after = "负责跟进这个问题并且会在明天的会议上同步进展同时整理一份测试清单覆盖中文英文和混合文本的情况确保两端看到的片段完全一致没有任何差别也不会改变接口的形状";
  assert.ok(before.length > 70, "the hit sits more than 70 characters in");
  const snippet = buildSnippet(`${before}remy${after}`, ["remy"]);

  assert.ok(snippet.startsWith("…"), snippet);
  const hitAt = snippet.indexOf("remy");
  const context = snippet.slice(1, hitAt);
  assert.equal(context, before.slice(-12));
  assert.equal(snippetWidth(context), SEARCH_SNIPPET_WIDTH_BEFORE_HIT);
  assert.ok(snippet.endsWith("…"), snippet);
  assert.equal(snippetWidth(snippet.slice(hitAt + 4, -1)), SEARCH_SNIPPET_WIDTH_AFTER_HIT);
});

test("snippet budgets mixed Latin and CJK text by display width", () => {
  const before = "Release notes 第二版 draft: 搜索 overlay 和 results 页面的高亮规则 need review by";
  const content = `${before} remy before Friday, 然后再合并到 staging 分支。`;
  const snippet = buildSnippet(content, ["remy"]);

  const hitAt = snippet.indexOf("remy");
  const context = snippet.slice(1, hitAt);
  assert.ok(snippet.startsWith("…"), snippet);
  assert.ok(content.includes(context), context);
  const width = snippetWidth(context);
  assert.ok(width <= SEARCH_SNIPPET_WIDTH_BEFORE_HIT && width >= SEARCH_SNIPPET_WIDTH_BEFORE_HIT - 4, `width ${width}: ${context}`);
  assert.ok(context.length > 8 && context.length < 24, `mixed text is neither all-wide nor all-narrow: ${context}`);
  assert.ok(snippet.endsWith("分支。"), snippet);
});

test("snippet keeps up to 24 Latin columns before a hit and never splits a surrogate pair", () => {
  const latin = buildSnippet(`${"word ".repeat(30)}remy and the rest`, ["remy"]);
  // The 24-column cut lands in "ord"; it moves on to the next word.
  assert.equal(latin, "…word word word word remy and the rest");

  const emoji = buildSnippet(`${"😀".repeat(30)}remy`, ["remy"]);
  assert.equal(emoji, `…${"😀".repeat(12)}remy`);

  assert.equal(buildSnippet("short note for remy", ["remy"]), "short note for remy");
});

test("snippet starts and ends on Latin word boundaries", () => {
  // Staging: "...f that is written down, Remy" (cut inside "of").
  const start = buildSnippet("Every decision of that is written down, Remy will check it", ["remy"]);
  assert.equal(start, "…that is written down, Remy will check it");

  // Staging: "…achments, previews; Remy" (cut inside "attachments").
  assert.equal(
    buildSnippet("Uploads, links and attachments, previews; or Remy owns the rest", ["remy"]),
    "…previews; or Remy owns the rest",
  );

  const tail = "lorem ".repeat(40);
  const snippet = buildSnippet(`remy ${tail}`, ["remy"]);
  assert.ok(snippet.endsWith("lorem…"), snippet);
  assert.ok(!snippet.endsWith(" …"), snippet);
  assert.ok(snippetWidth(snippet.slice(4, -1)) <= SEARCH_SNIPPET_WIDTH_AFTER_HIT, snippet);
  assert.equal(snippet, `remy ${tail.slice(0, 132).trimEnd()}…`);

  // A message with no hit keeps its start, also cut on a word boundary.
  const noHit = buildSnippet("alpha ".repeat(40), ["remy"]);
  assert.ok(noHit.endsWith("alpha…") && noHit.length <= 180, noHit);
});

test("snippet drops punctuation a CJK cut leaves at the start", () => {
  // Staging: "...，这些都写清楚之后再请 remy" (the cut left the comma).
  const snippet = buildSnippet("先把需求背景和验收标准整理好，这些都写清楚之后再请 remy 看一下", ["remy"]);
  assert.equal(snippet, "…这些都写清楚之后再请 remy 看一下");

  for (const mark of ["。", "、", "；", "：", ",", ".", ";", ":"]) {
    const cut = buildSnippet(`一二三四五六七八九十一二三四五${mark}一二三四五六七八九十请 remy`, ["remy"]);
    assert.ok(cut.startsWith("…一"), `${mark}: ${cut}`);
  }
});

test("snippet edge polish never cuts or hides the hit", () => {
  // A single word longer than the reach: no space to move to, the cut stays.
  const longWord = buildSnippet(`${"x".repeat(60)}remy`, ["remy"]);
  assert.equal(longWord, `…${"x".repeat(24)}remy`);

  // The hit is the whole word right after a long word: the cut may not pass it.
  const glued = buildSnippet(`${"y".repeat(30)}, remy`, ["remy"]);
  assert.ok(glued.endsWith("remy") && glued.startsWith("…y"), glued);

  // Punctuation inside the window stays; only the cut edge is polished, the hit (and its @) kept.
  assert.equal(buildSnippet(`${"一".repeat(12)}，@remy`, ["remy"]), "…一一一一一一一一一一，@remy");
  assert.equal(buildSnippet(`${"二".repeat(30)}，，，，，，，，，，，，，remy`, ["remy"]), "…remy");

  // A hit in a long word after the hit: the end cut never moves before the hit's end.
  const tailWord = buildSnippet(`remy${"z".repeat(300)}`, ["remy"]);
  assert.equal(tailWord, `remy${"z".repeat(SEARCH_SNIPPET_WIDTH_AFTER_HIT)}…`);
});

test("search visible set enumerates the visibility entry's roots and their live threads from the root side", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(buildVisibleConversationChannelsSql(VISIBLE_ROOTS));
  const rendered = normalizeSql(query.sql);

  assert.match(rendered, /\bUNION ALL\b/);
  assert.match(rendered, /\bFROM channels root_channels WHERE root_channels\.id = ANY\(\$\d+::uuid\[\]\) AND root_channels\.deleted_at IS NULL\b/);
  // Threads come from the parent side via channels.parent_channel_id, with the
  // partial index's predicate stated: no messages reads, no membership joins.
  assert.equal(rendered.match(/\bWHERE tc\.parent_channel_id = ANY\(\$\d+::uuid\[\]\) AND tc\.type = 'thread' AND tc\.deleted_at IS NULL\b/g)?.length, 2);
  // Task conversations (task v2) the same way, through their own partial index
  // (type = 'task'): under the local roots and under the joint storage.
  assert.equal(rendered.match(/\bWHERE tc\.parent_channel_id = ANY\(\$\d+::uuid\[\]\) AND tc\.type = 'task' AND tc\.deleted_at IS NULL\b/g)?.length, 2);
  assert.doesNotMatch(rendered, /\bmessages\b|\bchannel_agents\b|\bchannel_humans\b/);
  // One array parameter per id list, not one bind parameter per id.
  assert.ok(query.params.includes("{00000000-0000-4000-8000-000000000011,00000000-0000-4000-8000-000000000012,00000000-0000-4000-8000-000000000014,00000000-0000-4000-8000-000000000013}"));
  assert.ok(query.params.includes("{00000000-0000-4000-8000-000000000014}"), "canonical storage of the visible joint root");
});

test("search row-check visible set is one predicate from the channel side", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildVisibleConversationRowCheckSql(VISIBLE_ROOTS)).sql);

  // The recent walk checks visibility per message: a primary-key lookup the planner can memoize, not a UNION.
  assert.match(rendered, /^SELECT visible_channels\.id AS id, COALESCE\(visible_channels\.parent_channel_id, visible_channels\.id\) AS parent_channel_id FROM channels visible_channels WHERE visible_channels\.deleted_at IS NULL AND \(visible_channels\.id = ANY\(\$\d+::uuid\[\]\) OR visible_channels\.parent_channel_id = ANY\(\$\d+::uuid\[\]\)\)/);
  assert.doesNotMatch(rendered, /\bUNION\b/);
  assert.doesNotMatch(rendered, /\bmessages\b/);
});

test("relevance search collects text matches first, then keeps the visible ones before ranking", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  // A fixed shape, so the planner never chooses to run the GIN match once per
  // visible channel: text_matches holds only ids, content and rank read
  // visible rows only.
  assert.match(rendered, /^text_matches AS MATERIALIZED \( SELECT m\.id AS id, m\.channel_id AS channel_id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.match(rendered, /\bmatched_messages AS MATERIALIZED \(.*\bFROM text_matches tm JOIN visible_channels vc ON vc\.id = tm\.channel_id JOIN messages m ON m\.id = tm\.id WHERE\b/);
  assert.match(rendered, /\bFROM matched_messages mm ORDER BY\b/);
  assert.doesNotMatch(rendered, /\bFROM visible_channels vc JOIN messages m\b/);
  assert.doesNotMatch(rendered, /\bFROM matched_messages mm JOIN visible_channels vc\b/);
});

test("relevance search narrows text matches to the filtered channel and keeps the exact filter after visibility", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql`AND (m.channel_id = ${"channel-1"} OR vc.parent_channel_id = ${"channel-1"})`,
    channelScopeFilter: sql`AND m.channel_id IN (SELECT ${"channel-1"}::uuid)`,
    textMatchChannelScopeFilter: sql`AND m.channel_id = ANY(ARRAY(SELECT ${"channel-1"}::uuid))`,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(
    rendered,
    /^text_matches AS MATERIALIZED \(.*\bAND m\.channel_id = ANY\(ARRAY\(SELECT \$\d+::uuid\)\).*\), matched_messages AS MATERIALIZED \(.*\bAND \(m\.channel_id = \$\d+ OR vc\.parent_channel_id = \$\d+\).*\), search_candidates AS \(/,
  );
});

test("channel filter: text matches get the scope as a precomputed array, the walk keeps the hashed IN", async () => {
  const { buildMessageSearchStatement } = await import("./searchService");
  const dialect = new PgDialect();
  const render = (sort: "relevance" | "recent", recentPlan?: "walk" | "text_matches_first") => normalizeSql(dialect.sqlToQuery(buildMessageSearchStatement(
    sql`SELECT NULL::uuid AS id, NULL::uuid AS parent_channel_id`,
    { serverId: "00000000-0000-4000-8000-000000000001", channelId: "00000000-0000-4000-8000-000000000009", sort, recentPlan, limit: 20, offset: 0 },
    sql`plainto_tsquery('simple', ${"flaky"})`,
  )).sql);

  // As IN (subquery) the planner can rescan the GIN index once per scoped
  // thread (3,241 rescans, 4.8s on a 3,240-thread channel); an InitPlan array
  // keeps it to one GIN scan.
  for (const rendered of [render("relevance"), render("recent", "text_matches_first")]) {
    assert.match(rendered, /\bWITH visible_channels AS \(.*\), text_matches AS MATERIALIZED \( SELECT m\.id AS id, m\.channel_id AS channel_id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\) AND m\.channel_id = ANY\(ARRAY\( SELECT \$\d+::uuid UNION ALL SELECT scoped_thread\.id FROM channels scoped_thread/);
    assert.doesNotMatch(rendered, /\bm\.channel_id IN \(/);
  }
  // The walk filters every row it passes by the scope: IN is hashed, a parameter array is not (15.5s vs 0.6s).
  const walk = render("recent", "walk");
  assert.match(walk, /\bAND m\.channel_id IN \( SELECT \$\d+::uuid UNION ALL SELECT scoped_thread\.id/);
  assert.doesNotMatch(walk, /\bANY\(ARRAY\(/);
});

test("server timeline walk: the text match cannot become a GIN index condition", async () => {
  const { buildMessageSearchStatement } = await import("./searchService");
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildMessageSearchStatement(
    sql`SELECT NULL::uuid AS id, NULL::uuid AS parent_channel_id`,
    { serverId: "00000000-0000-4000-8000-000000000001", sort: "recent", recentPlan: "server_timeline_walk", limit: 20, offset: 0 },
    sql`plainto_tsquery('simple', ${"means"})`,
  )).sql);

  // A bare @@ lets the planner loop over the visible channels with
  // BitmapAnd(channel index, GIN), rescanning the match set per channel
  // (2,152 rescans, 27s on a 34k-message server) instead of walking.
  assert.match(rendered, /\bFROM message_server_timeline t JOIN messages m ON m\.id = t\.message_id\b.*\bAND \(m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)\) IS TRUE ORDER BY t\.created_at DESC, t\.message_id DESC\b/);
  assert.doesNotMatch(rendered, /\bAND m\.search_vector @@/);
});

test("server timeline walk: with search_server_gin_v0 it pre-filters on the timeline's vector and still re-checks the message", async () => {
  const { buildMessageSearchStatement } = await import("./searchService");
  const dialect = new PgDialect();
  const render = (textMatchServerIds?: readonly string[]) => normalizeSql(dialect.sqlToQuery(buildMessageSearchStatement(
    sql`SELECT NULL::uuid AS id, NULL::uuid AS parent_channel_id`,
    { serverId: "00000000-0000-4000-8000-000000000001", sort: "recent", recentPlan: "server_timeline_walk", limit: 20, offset: 0, textMatchServerIds },
    sql`plainto_tsquery('simple', ${"means"})`,
  )).sql);

  // Flag on: rows that do not match cost no messages read (prod 1.5 s -> 0.3 s);
  // the message check stays, so a stale timeline copy can only drop a message.
  const on = render(["00000000-0000-4000-8000-000000000001"]);
  assert.match(on, /\bAND \(t\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)\) IS TRUE AND \(m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)\) IS TRUE ORDER BY t\.created_at DESC, t\.message_id DESC\b/);
  assert.doesNotMatch(on, /\bAND t\.search_vector @@/, "IS TRUE keeps it from becoming a GIN index condition");
  // Flag off: the timeline's vector may not be filled; only the message's is read.
  assert.doesNotMatch(render(), /\bt\.search_vector\b/);
});

test("filter-only search keeps the page-first visible-channel plan", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: null,
    sort: "recent",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql`AND m.sender_id = ${"sender-1"}`,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^search_candidates AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.doesNotMatch(rendered, /\bmatched_messages AS MATERIALIZED\b/);
  assert.doesNotMatch(rendered, /\bm\.search_vector @@\b/);
});

test("broad recent search uses the exact page-first visible-channel plan", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    sort: "recent",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^search_candidates AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.match(rendered, /\bm\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.doesNotMatch(rendered, /\bmatched_messages AS MATERIALIZED\b/);
});

test("recent search on a bounded term takes text matches first and orders by time without ranking", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"flaky"})`,
    sort: "recent",
    recentPlan: "text_matches_first",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    channelScopeFilter: sql``,
    textMatchChannelScopeFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^text_matches AS MATERIALIZED \(/);
  assert.match(rendered, /\bFROM text_matches tm JOIN visible_channels vc ON vc\.id = tm\.channel_id\b/);
  // Same order as the walk (created_at, then id), and no ts_rank_cd over the matches.
  assert.match(rendered, /\b0 AS "searchRank" FROM matched_messages mm ORDER BY mm\.created_at DESC, mm\.id DESC\b/);
  assert.doesNotMatch(rendered, /\bts_rank_cd\b/);
});

test("breadth probe uses non-executing EXPLAIN over the viewer-scoped filtered FTS query", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(buildMessageSearchBreadthProbeSql({
    visibleChannelsSql: sql`SELECT ${"channel-1"}::text AS id, ${"channel-1"}::text AS parent_channel_id`,
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    channelFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  }));
  const rendered = normalizeSql(query.sql);

  assert.match(rendered, /^EXPLAIN \(FORMAT JSON\) WITH visible_channels AS \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id\b/);
  assert.match(rendered, /\bm\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.doesNotMatch(rendered, /\bLIMIT\b|\bANALYZE\b/);
});

test("text-match probe plans the relevance statement's corpus-wide text_matches predicate without executing it", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildMessageSearchTextMatchProbeSql({
    tsQuery: sql`plainto_tsquery('simple', ${"the"})`,
    channelScopeFilter: sql`AND m.channel_id IN (SELECT ${"channel-1"}::uuid)`,
    senderFilter: sql`AND m.sender_id = ${"sender-1"}`,
    senderTypeFilter: sql``,
  })).sql);

  assert.match(rendered, /^EXPLAIN \(FORMAT JSON\) SELECT m\.id FROM messages m WHERE m\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\) AND m\.channel_id IN \(SELECT \$\d+::uuid\) AND m\.sender_id = \$\d+$/);
  assert.doesNotMatch(rendered, /\bvisible_channels\b|\bLIMIT\b|\bANALYZE\b/);
});

test("text-match classification rejects only estimates above both the fixed limit and the common-term share of the corpus", () => {
  const small = 1_000_000;
  assert.equal(classifyMessageSearchTextMatchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT, small), "within_limit");
  assert.equal(classifyMessageSearchTextMatchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT + 1, small), "over_limit");
  // A term missing from the statistics is estimated at up to 0.5% of the
  // corpus; on a corpus large enough for that to pass the fixed limit, such a
  // term must stay admitted.
  const large = 100_000_000;
  assert.equal(classifyMessageSearchTextMatchBreadth(large * 0.005, large), "within_limit");
  assert.equal(classifyMessageSearchTextMatchBreadth(large * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION + 1, large), "over_limit");
  assert.throws(() => classifyMessageSearchTextMatchBreadth(-1, small));
  assert.throws(() => classifyMessageSearchTextMatchBreadth(1, Number.NaN));
});

test("a Free server's history cutoff narrows the results, never the breadth probes", async () => {
  const {
    __resetSearchServiceDepsForTests,
    __setSearchServiceDepsForTests,
    searchMessagesForUser,
  } = await import("./searchService");
  const dialect = new PgDialect();
  // The probes estimate how many text matches the GIN index reads across every
  // server. A date bound shrinks that estimate but not the read, so a cutoff in
  // the probe would admit common terms that then run to the statement timeout.
  const probesFor = async (historyCutoff: Date | undefined, requested: { after?: Date; before?: Date } = {}) => {
    const probes: Array<{ sql: string; params: unknown[] }> = [];
    __setSearchServiceDepsForTests({
      visibleRootChannelIds: async () => VISIBLE_ROOTS,
      executeSearchSql: (async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        const rendered = normalizeSql(query.sql);
        // Both breadth probes ran: what follows is the newest-first answer
        // (relevanceFallback), not under test here.
        if (probes.length === 2) throw new Error("breadth probes done");
        if (rendered.startsWith("EXPLAIN")) {
          probes.push({ sql: rendered, params: query.params });
          // Few visible candidates, too many corpus-wide text matches: over the cap after both probes.
          const planRows = rendered.includes("visible_channels") ? 1 : 10_000_000;
          return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Bitmap Heap Scan", "Plan Rows": planRows } }] }] };
        }
        if (rendered.includes("reltuples")) return { rows: [{ corpus_rows: 20_000_000 }] };
        throw new Error(`unexpected statement: ${rendered.slice(0, 80)}`);
      }) as never,
    });
    try {
      await assert.rejects(
        searchMessagesForUser({
          serverId: "00000000-0000-4000-8000-000000000001",
          userId: "00000000-0000-4000-8000-000000000002",
          query: "deploy",
          ...requested,
          historyCutoff,
          sort: "relevance",
          limit: 20,
        }),
        (error: Error & { cause?: Error }) => /breadth probes done/.test(error.cause?.message ?? error.message),
      );
    } finally {
      __resetSearchServiceDepsForTests();
    }
    return probes;
  };

  const unlimited = await probesFor(undefined);
  const free = await probesFor(new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(unlimited.length, 2, "candidate probe and corpus-wide text-match probe");
  assert.deepEqual(free, unlimited, "the cutoff leaves both probes exactly as on an unlimited plan");
  assert.ok(free.every((probe) => !/\bm\.created_at\b/.test(probe.sql)), "no date bound the caller did not ask for");

  // A range the caller asks for narrows the visible-candidate probe, but the
  // corpus-wide text-match probe stays date-free: the GIN index reads every
  // match of the term whatever the range, so `deploy` + one week must still be
  // over the cap (answered newest first) instead of running to the statement timeout.
  const ranged = await probesFor(undefined, {
    after: new Date("2026-10-14T00:00:00.000Z"),
    before: new Date("2026-10-21T00:00:00.000Z"),
  });
  const candidateProbe = ranged.find((probe) => probe.sql.includes("visible_channels"));
  const textMatchProbe = ranged.find((probe) => !probe.sql.includes("visible_channels"));
  assert.ok(candidateProbe && textMatchProbe, "both probes ran");
  assert.match(candidateProbe.sql, /\bm\.created_at >= \$\d+.*\bm\.created_at <= \$\d+/);
  assert.doesNotMatch(textMatchProbe.sql, /\bcreated_at\b/);
  assert.deepEqual(textMatchProbe, unlimited.find((probe) => !probe.sql.includes("visible_channels")));
});

test("breadth classification accepts the injected threshold and rejects the first estimate above it", () => {
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT - 1), "within_limit");
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT), "within_limit");
  assert.equal(classifyMessageSearchBreadth(MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT + 1), "over_limit");
  assert.throws(() => classifyMessageSearchBreadth(-1));
});

test("planner estimate projection is schema-strict and never converts unknown into absence", () => {
  const valid = [{ Plan: { "Node Type": "Nested Loop", "Plan Rows": 42 } }];
  assert.equal(readMessageSearchEstimatedCandidateRows(valid), 42);
  assert.equal(readMessageSearchEstimatedCandidateRows(JSON.stringify(valid)), 42);
  for (const malformed of [null, [], [{ Plan: null }], [{ Plan: { "Plan Rows": null } }], [{ Plan: { "Plan Rows": -1 } }]]) {
    assert.throws(() => readMessageSearchEstimatedCandidateRows(malformed), { name: "MessageSearchUnavailableError" });
  }
});

test("the recent plan collects text matches first only up to the recent cap", () => {
  assert.equal(chooseMessageSearchRecentPlan(0), "text_matches_first");
  assert.equal(chooseMessageSearchRecentPlan(MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT), "text_matches_first");
  assert.equal(chooseMessageSearchRecentPlan(MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT + 1), "walk");
  assert.equal(chooseMessageSearchRecentPlan(18_000), "walk", "the 10-16 timeout shape");
  assert.equal(chooseMessageSearchRecentPlan(Number.NaN), "walk");
});
