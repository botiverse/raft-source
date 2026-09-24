import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildAgentVisibleChannelsSql,
  buildMessageSearchBreadthProbeSql,
  buildSearchCandidateCtes,
  buildSearchText,
  classifyMessageSearchBreadth,
  MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
  preprocessSearchContent,
  readMessageSearchEstimatedCandidateRows,
  tokenizeSearchText,
} from "./searchService.js";

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

test("agent search visible-channel query is agent-first without membership left joins", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildAgentVisibleChannelsSql({
    serverId: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
  })).sql);

  assert.match(rendered, /\bUNION ALL\b/);
  assert.match(rendered, /\bFROM channel_agents ca JOIN channels member_channels\b/);
  assert.match(rendered, /\bJOIN channel_agents pca ON pca\.channel_id = pc\.id AND pca\.agent_id = \$\d+\b/);
  assert.doesNotMatch(rendered, /\bLEFT JOIN channel_agents\b/);
  assert.doesNotMatch(rendered, /\bmember_channels\.type IN \('private', 'dm'\) AND ca\.agent_id IS NOT NULL\b/);
  assert.doesNotMatch(rendered, /\bpc\.type IN \('private', 'dm'\) AND pca\.agent_id IS NOT NULL\b/);
});

test("keyword search scopes full-text matches to visible channels before materializing them", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(rendered, /^matched_messages AS MATERIALIZED \(/);
  assert.match(rendered, /\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id WHERE\b.*\bm\.search_vector @@ \(plainto_tsquery\('simple', \$\d+\)\)/);
  assert.match(rendered, /\bFROM matched_messages mm ORDER BY\b/);
  assert.doesNotMatch(rendered, /\bFROM messages m WHERE\b/);
  assert.doesNotMatch(rendered, /\bFROM matched_messages mm JOIN visible_channels vc\b/);
});

test("keyword search applies a channel and thread filter before materializing matches", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: sql`plainto_tsquery('simple', ${"hehe"})`,
    sort: "relevance",
    limit: 20,
    offset: 0,
    channelFilter: sql`AND (m.channel_id = ${"channel-1"} OR vc.parent_channel_id = ${"channel-1"})`,
    senderFilter: sql``,
    senderTypeFilter: sql``,
    mentionTargetFilter: sql``,
    afterFilter: sql``,
    beforeFilter: sql``,
  })).sql);

  assert.match(
    rendered,
    /^matched_messages AS MATERIALIZED \(.*\bFROM visible_channels vc JOIN messages m ON m\.channel_id = vc\.id WHERE\b.*\bAND \(m\.channel_id = \$\d+ OR vc\.parent_channel_id = \$\d+\).*\), search_candidates AS \(/,
  );
});

test("filter-only search keeps the page-first visible-channel plan", () => {
  const dialect = new PgDialect();
  const rendered = normalizeSql(dialect.sqlToQuery(buildSearchCandidateCtes({
    tsQuery: null,
    sort: "recent",
    limit: 20,
    offset: 0,
    channelFilter: sql``,
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

test("search manual is structurally bound to the code threshold and probe deadline", () => {
  const manual = readFileSync(new URL("../../../../manual/agent-knowledge/search.md", import.meta.url), "utf8");
  assert.match(manual, new RegExp(`at most \\*\\*${MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT.toLocaleString("en-US")} planner-estimated candidate rows\\*\\*`));
  assert.match(manual, new RegExp(`above ${MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT.toLocaleString("en-US")} produces`));
  assert.match(manual, new RegExp(`\\*\\*${MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS.toLocaleString("en-US")} ms\\*\\*`));
});
