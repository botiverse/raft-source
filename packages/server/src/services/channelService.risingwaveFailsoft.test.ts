import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { getDb } from "../db/index.js";
import type { RisingWaveQueryRead } from "../db/risingwave.js";
import { channelHumans, channels, messages, readMutationAuthorities, servers, userChannelReadCursors, users } from "../db/schema.js";
import type { DbQueryTracer } from "../tracing/dbQueryTrace.js";
import { withTraceRoot } from "../tracing/semanticTrace.js";
import { __testInboxPgFallbackTimeout, __testRisingWaveInboxFailSoft } from "./channelService.js";


const TEST_ROOT_SPAN = { surface: "server" as const, kind: "server" as const };

const fakePool = {
  totalCount: 4,
  idleCount: 1,
  waitingCount: 2,
};

function configureFailSoftDeps(nowRef = { value: 1_000 }) {
  __testRisingWaveInboxFailSoft.setDeps({
    getPool: () => fakePool as any,
    getRfc056ServingMode: () => "on",
    nowMs: () => nowRef.value,
    random: () => 0,
  });
  return nowRef;
}

function acquireTimeout() {
  return Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ETIMEDOUT" });
}

afterEach(() => {
  __testRisingWaveInboxFailSoft.reset();
});

beforeAll(() => openTestDatabase("pglite://"));
afterAll(() => closeTestDatabase().catch(() => {}));

function makeTraceHarness() {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "f".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  return { sink, tracer };
}

function latestSpanEvents(sink: MemoryTraceSink) {
  const span = sink.getAllSpans().at(-1);
  assert.ok(span);
  return span.events;
}

function eventAttrs(events: ReturnType<typeof latestSpanEvents>, name: string) {
  const event = events.find((candidate) => candidate.name === name);
  assert.ok(event, `missing trace event ${name}`);
  return event.attrs ?? {};
}

function eventsNamed(events: ReturnType<typeof latestSpanEvents>, name: string) {
  return events.filter((event) => event.name === name);
}

function makeWrapperTraceQuery(calls: string[]): DbQueryTracer {
  let invoked = 0;
  return async (queryName, _work, onComplete) => {
    invoked += 1;
    if (invoked === 1) return _work();
    calls.push(queryName);
    let result: any;
    if (queryName === "channels.inbox_items_by_user") {
      result = { rows: [] };
    } else if (queryName === "channels.unread_counts_by_user") {
      result = { rows: [] };
    } else if (queryName === "servers.sidebar_unread_counts_by_user") {
      result = { rows: [] };
    } else {
      throw new Error(`unexpected query ${queryName}`);
    }
    const attrs = onComplete?.(result);
    const { addTraceEvent } = await import("../tracing/semanticTrace.js");
    addTraceEvent("db.query.finished", {
      query_name: queryName,
      ...(attrs ?? {}),
    });
    return result;
  };
}

test("all page key prefixes merge with serving precedence and stable post-union paging", () => {
  const row = (
    sourceChannelId: string,
    activityAt: string,
    producer: "serving" | "mention",
    kind = "channel",
  ): QueryResultRow => ({
    _kind: kind,
    _sourceChannelId: sourceChannelId,
    _lastActivityAt: activityAt,
    producer,
  });
  const servingRows = [
    row(
      "00000000-0000-0000-0000-00000000000a",
      "2026-08-04T03:00:00.000Z",
      "serving",
    ),
    row(
      "00000000-0000-0000-0000-00000000000c",
      "2026-08-04T01:00:00.000Z",
      "serving",
      "thread",
    ),
  ];
  const mentionRows = [
    row(
      "00000000-0000-0000-0000-00000000000a",
      "2026-08-04T04:00:00.000Z",
      "mention",
    ),
    row(
      "00000000-0000-0000-0000-00000000000b",
      "2026-08-04T02:00:00.000Z",
      "mention",
    ),
    row(
      "00000000-0000-0000-0000-00000000000d",
      "2026-08-04T00:00:00.000Z",
      "mention",
    ),
  ];

  const descendingPage = __testInboxPgFallbackTimeout.mergeAllPageKeyRows(
    servingRows,
    mentionRows,
    "desc",
    1,
    2,
  );
  assert.deepEqual(
    descendingPage.map((candidate) => candidate._sourceChannelId),
    [
      "00000000-0000-0000-0000-00000000000b",
      "00000000-0000-0000-0000-00000000000c",
      "00000000-0000-0000-0000-00000000000d",
    ],
    "offset/limit+1 must apply only after the two prefixes are merged",
  );
  assert.deepEqual(
    descendingPage.map((candidate) => candidate._pageOrdinal),
    [0, 1, 2],
  );

  const ascending = __testInboxPgFallbackTimeout.mergeAllPageKeyRows(
    servingRows,
    mentionRows,
    "asc",
    0,
    4,
  );
  assert.deepEqual(
    ascending.map((candidate) => candidate._sourceChannelId),
    [
      "00000000-0000-0000-0000-00000000000d",
      "00000000-0000-0000-0000-00000000000c",
      "00000000-0000-0000-0000-00000000000b",
      "00000000-0000-0000-0000-00000000000a",
    ],
  );
  assert.equal(
    ascending.at(-1)?.producer,
    "serving",
    "a duplicate mention candidate must retain the serving-row payload and ordering",
  );
});

test("inbox PG fallback timeout telemetry classifies the scoped brake without SQLSTATE inference", () => {
  const timeoutPlan = { inheritedTimeoutMs: 15_000, effectiveTimeoutMs: 3_000 };
  const direct = __testInboxPgFallbackTimeout.errorTraceAttrs(
    "875f8cd20750256b",
    Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    timeoutPlan,
  );
  assert.equal(__testInboxPgFallbackTimeout.queryName, "channels.inbox_items_serving_rows_by_user");
  assert.equal(__testInboxPgFallbackTimeout.queryIdentity, "inbox_items_serving_rows_v13");
  assert.equal(__testInboxPgFallbackTimeout.statementTimeoutCapMs, 3_000);
  assert.equal(__testInboxPgFallbackTimeout.timeoutScope, "transaction_local");
  assert.equal(__testInboxPgFallbackTimeout.effectiveTimeoutMs(0), 3_000, "unlimited inherits the 3s cap");
  assert.equal(__testInboxPgFallbackTimeout.effectiveTimeoutMs(15_000), 3_000, "the prod 15s role policy is tightened");
  assert.equal(__testInboxPgFallbackTimeout.effectiveTimeoutMs(2_000), 2_000, "a stricter inherited policy is never widened");
  assert.equal(direct["pg.fallback.query_name"], __testInboxPgFallbackTimeout.queryName);
  assert.equal(direct["pg.fallback.query_identity"], __testInboxPgFallbackTimeout.queryIdentity);
  assert.equal(direct["pg.fallback.query_hash"], "875f8cd20750256b");
  assert.equal(direct["pg.fallback.legacy_query_hash"], "ff11a9e16bc68872");
  assert.equal(direct["pg.fallback.timeout_scope"], "transaction_local");
  assert.equal(direct["pg.fallback.statement_timeout_cap_ms"], 3_000);
  assert.equal(direct["pg.fallback.inherited_statement_timeout_ms"], 15_000);
  assert.equal(direct["pg.fallback.effective_statement_timeout_ms"], 3_000);
  assert.equal(direct["pg.fallback.outcome"], "statement_timeout");
  assert.equal(direct.reason, "statement_timeout");
  assert.equal(direct.sqlstate, "57014");

  const other = __testInboxPgFallbackTimeout.errorTraceAttrs(
    "query-hash",
    Object.assign(new Error("database unavailable"), { code: "57P01" }),
  );
  assert.equal(other["pg.fallback.outcome"], "query_error");
  assert.equal(other.reason, "database_error");
  assert.equal(other.sqlstate, "57P01");
});

test("inbox mention aggregation emits mutually exclusive all and non-all SQL shapes", () => {
  const source = readFileSync(new URL("./channelService.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /const isAllFilter = opts\.filter === "all";[\s\S]*const mentionAggregationCtes = isAllFilter[\s\S]*SELECT DISTINCT mention\.source_channel_id[\s\S]*NULL::uuid AS latest_message_id[\s\S]*:[\s\S]*SELECT NULL::uuid AS source_channel_id[\s\S]*array_agg\(mention\.message_id ORDER BY mention\.message_seq DESC/,
    "all and non-all queries must build mutually exclusive bulk mention aggregation shapes",
  );
  assert.match(
    source,
    /const pageMentionAggregationCte = isAllFilter[\s\S]*INNER JOIN page selected_page[\s\S]*:[\s\S]*NULL::uuid AS latest_message_id[\s\S]*\$\{mentionAggregationCtes\}[\s\S]*AND \$\{filterPredicate\}[\s\S]*\$\{pageMentionAggregationCte\}/,
    "all must compute exact mention aggregates only for page rows while non-all emits an empty page aggregate",
  );
  assert.doesNotMatch(source, /\$\{opts\.filter\} = 'all'|\$\{opts\.filter\} <> 'all'/);
  assert.doesNotMatch(source, /plan_cache_mode|force_generic_plan/);
});

test("RisingWave inbox fail-soft routes connection/acquire errors to bounded Postgres fallback for all affected routes", async () => {
  for (const route of ["all", "channel_unread", "sidebar_summary"] as const) {
    __testRisingWaveInboxFailSoft.reset();
    configureFailSoftDeps();
    const { sink, tracer } = makeTraceHarness();

    const result = await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, () =>
      __testRisingWaveInboxFailSoft.readWithPostgresFallback<string>(
        route,
        7,
        async () => {
          throw acquireTimeout();
        },
        async (attempt) => {
          assert.equal(attempt.fallbackReason, "rw_error");
          assert.equal(attempt.failSoftReason, "connection_acquire_error");
          return `pg:${route}`;
        },
      ));

    assert.equal(result.backend, "pg_legacy");
    assert.equal(result.result, `pg:${route}`);
    assert.equal(__testRisingWaveInboxFailSoft.getBreakerState(), "open");
    const events = latestSpanEvents(sink);
    const failed = eventAttrs(events, "inbox.backend.failed");
    assert.equal(failed.terminal_status, undefined);
    assert.equal(failed.fallback_outcome, undefined);
    assert.equal(failed.reason, "rw_error");
    const completed = eventAttrs(events, "inbox.backend.fallback_completed");
    assert.equal(completed.fallback_outcome, "success");
    assert.equal(completed.terminal_status, undefined);
  }
});

test("RisingWave inbox item routes fail soft on schema/query errors while legacy count routes remain strict", async () => {
  configureFailSoftDeps();
  const { sink, tracer } = makeTraceHarness();

  const allAttempt = await withTraceRoot(
    tracer,
    "server.http.request",
    TEST_ROOT_SPAN,
    () => __testRisingWaveInboxFailSoft.read<string>("all", 7, async () => {
      throw Object.assign(new Error("syntax error at or near SELECT"), { code: "42601" });
    }),
  );
  assert.equal(allAttempt.result, null);
  assert.equal(allAttempt.fallbackReason, "rw_error");
  assert.equal(allAttempt.failSoftReason, "query_error");
  const failed = eventAttrs(latestSpanEvents(sink), "inbox.backend.failed");
  assert.equal(failed.terminal_status, undefined);

  __testRisingWaveInboxFailSoft.reset();
  configureFailSoftDeps();
  await assert.rejects(
    __testRisingWaveInboxFailSoft.read<string>("channel_unread", 7, async () => {
      throw Object.assign(new Error("syntax error at or near SELECT"), { code: "42601" });
    }),
    /syntax error/,
  );

  __testRisingWaveInboxFailSoft.reset();
  configureFailSoftDeps();
  await assert.rejects(
    __testRisingWaveInboxFailSoft.readWithPostgresFallback<string>(
      "all",
      7,
      async () => {
        throw acquireTimeout();
      },
      async () => {
        throw new Error("postgres fallback failed");
      },
    ),
    /postgres fallback failed/,
  );
});

test("RisingWave inbox breaker bypasses while open, then permits a single half-open probe", async () => {
  const nowRef = configureFailSoftDeps();
  await __testRisingWaveInboxFailSoft.read<string>("sidebar_summary", 7, async () => {
    throw acquireTimeout();
  });

  let rwReads = 0;
  const openBypass = await __testRisingWaveInboxFailSoft.readWithPostgresFallback<string>(
    "sidebar_summary",
    7,
    async () => {
      rwReads += 1;
      return "rw-open";
    },
    async (attempt) => {
      assert.equal(attempt.failSoftReason, "breaker_open");
      assert.equal(attempt.fallbackReason, "breaker_open");
      return "pg-open";
    },
  );
  assert.equal(openBypass.backend, "pg_legacy");
  assert.equal(openBypass.result, "pg-open");
  assert.equal(rwReads, 0);

  nowRef.value += 5_001;
  let releaseProbe!: () => void;
  const firstHalfOpen = __testRisingWaveInboxFailSoft.read<string>("sidebar_summary", 7, async () => {
    rwReads += 1;
    await new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    return "rw-half-open";
  });
  const secondHalfOpen = await __testRisingWaveInboxFailSoft.readWithPostgresFallback<string>(
    "sidebar_summary",
    7,
    async () => {
      rwReads += 1;
      return "rw-second";
    },
    async (attempt) => {
      assert.equal(attempt.failSoftReason, "breaker_open");
      assert.equal(attempt.fallbackReason, "breaker_open");
      return "pg-half-open";
    },
  );

  assert.equal(secondHalfOpen.backend, "pg_legacy");
  assert.equal(secondHalfOpen.result, "pg-half-open");
  assert.equal(rwReads, 1);

  releaseProbe();
  const probeResult = await firstHalfOpen;
  assert.equal(probeResult.result, "rw-half-open");
  assert.equal(__testRisingWaveInboxFailSoft.getBreakerState(nowRef.value), "closed");
});

test("RisingWave inbox breaker-open fallback uses one reason and no synthetic error kind", async () => {
  configureFailSoftDeps();
  const { sink, tracer } = makeTraceHarness();

  await __testRisingWaveInboxFailSoft.read<string>("sidebar_summary", 7, async () => {
    throw acquireTimeout();
  });

  await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, () =>
    __testRisingWaveInboxFailSoft.readWithPostgresFallback<string>(
      "sidebar_summary",
      7,
      async () => "rw-unreachable",
      async () => "pg-breaker",
    ));

  const events = latestSpanEvents(sink);
  const fallback = eventAttrs(events, "inbox.rw.failsoft.fallback");
  assert.equal(fallback.reason, "breaker_open");
  assert.equal(fallback.inbox_fallback_reason, "breaker_open");
  const completed = eventAttrs(events, "inbox.backend.fallback_completed");
  assert.equal(completed.reason, "breaker_open");
  assert.equal(completed.inbox_fallback_reason, "breaker_open");
  assert.equal(completed.error_kind, undefined);
  assert.equal(completed.error_class, undefined);
});

test("RisingWave inbox production wrappers fail soft to Postgres with consistent route trace attrs", async () => {
  for (const route of ["all", "channel_unread", "sidebar_summary"] as const) {
    __testRisingWaveInboxFailSoft.reset();
    configureFailSoftDeps();
    const pgQueries: string[] = [];
    const traceQuery = makeWrapperTraceQuery(pgQueries);
    const { sink, tracer } = makeTraceHarness();
    let rwQueries = 0;

    __testRisingWaveInboxFailSoft.setDeps({
      getInboxItemsServingVersion: async () => 2,
      getJointStorageServerIds: async () => new Set(),
      query: async () => {
        rwQueries += 1;
        throw acquireTimeout();
      },
    });

    await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, async () => {
      if (route === "all") {
        const result = await __testRisingWaveInboxFailSoft.callInboxItemsWrapper("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", {
          filter: "all",
          traceQuery,
          humanActivityMuteEnabled: false,
        });
        assert.deepEqual(result.items, []);
      } else if (route === "channel_unread") {
        const result = await __testRisingWaveInboxFailSoft.callUnreadCountsWrapper(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          undefined,
          { traceQuery },
        );
        assert.deepEqual(result, {});
      } else {
        const result = await __testRisingWaveInboxFailSoft.callSidebarUnreadSummaryCountsWrapper(
          [{ serverId: "00000000-0000-4000-8000-000000000001" }],
          "00000000-0000-4000-8000-000000000002",
          { traceQuery },
        );
        assert.deepEqual(result, { "00000000-0000-4000-8000-000000000001": 0 });
      }
    });

    assert.equal(rwQueries, 1);
    assert.deepEqual(pgQueries, [
      route === "all"
        ? "channels.inbox_items_by_user"
        : route === "channel_unread"
          ? "channels.unread_counts_by_user"
          : "servers.sidebar_unread_counts_by_user",
    ]);
    const events = latestSpanEvents(sink);
    const failed = eventAttrs(events, "inbox.backend.failed");
    assert.equal(failed.inbox_route, route);
    assert.equal(failed.terminal_status, undefined);
    const completed = eventAttrs(events, "inbox.backend.fallback_completed");
    assert.equal(completed.inbox_route, route);
    assert.equal(completed.reason, "rw_error");
    assert.equal(completed.fallback_outcome, "success");
    const selected = eventsNamed(events, "inbox.backend.selected").at(-1)?.attrs ?? {};
    assert.equal(selected.inbox_route, route);
    assert.equal(selected.inbox_fallback_reason, "rw_error");
  }
});

test("RisingWave inbox channel facet binds null and non-null channelId through the varchar-compatible prepare path", async () => {
  configureFailSoftDeps();
  const serverId = "00000000-0000-4000-8000-000000000101";
  const userId = "00000000-0000-4000-8000-000000000102";
  const channelId = "00000000-0000-4000-8000-000000000103";
  const prepared: Array<{ queryText: string; values: unknown[] }> = [];

  __testRisingWaveInboxFailSoft.setDeps({
    getInboxItemsServingVersion: async () => 2,
    query: (async (_pool: unknown, queryText: string, values?: unknown[]) => {
      prepared.push({ queryText, values: values ?? [] });
      return {
        result: {
          rows: [{
            kind: null,
            readAuthorityPresent: false,
            readAuthoritySeq: 0,
            totalCount: 0,
            totalUnreadCount: 0,
            activeUnreadCount: 0,
          }],
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
        },
        acquireWaitMs: 0,
        poolState: {
          rw_pool_total: 1,
          rw_pool_idle: 1,
          rw_pool_waiting: 0,
        },
      };
    }) as any,
  });

  for (const scopedChannelId of [undefined, channelId]) {
    const result = await __testRisingWaveInboxFailSoft.callInboxItemsWrapper(
      serverId,
      userId,
      {
        filter: "all",
        channelId: scopedChannelId,
        humanActivityMuteEnabled: false,
      },
    );
    assert.deepEqual(result.items, []);
  }

  assert.equal(prepared.length, 2);
  for (const { queryText } of prepared) {
    assert.match(
      queryText,
      /WHERE \$5::text IS NULL OR "groupChannelId" = \$5::text/,
      "RW must infer and compare the channel facet through its supported varchar/text domain",
    );
    assert.doesNotMatch(queryText, /\$5::uuid/);
  }
  assert.equal(prepared[0]?.values[4], null, "unscoped Activity prepares a SQL NULL channel facet");
  assert.equal(prepared[1]?.values[4], channelId, "scoped Activity prepares the validated channel UUID as text");
});

test("RFC056 off mode performs zero candidate reads and returns canonical Postgres", async () => {
  configureFailSoftDeps();
  const { sink, tracer } = makeTraceHarness();
  let rwQueries = 0;
  let servingVersionReads = 0;
  __testRisingWaveInboxFailSoft.setDeps({
    getRfc056ServingMode: () => "off",
    getInboxItemsServingVersion: async () => {
      servingVersionReads += 1;
      return 2;
    },
    query: async () => {
      rwQueries += 1;
      throw new Error("off mode must not query RisingWave");
    },
  });

  const result = await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, () =>
    __testRisingWaveInboxFailSoft.callInboxItemsWrapper(
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      { filter: "all", humanActivityMuteEnabled: false },
    ));

  assert.deepEqual(result, {
    items: [],
    groups: [],
    hasMore: false,
    totalCount: 0,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  });
  assert.equal(rwQueries, 0);
  assert.equal(servingVersionReads, 0);
  const events = latestSpanEvents(sink);
  const decision = eventAttrs(events, "inbox.rw.rfc056_serving_guard.decision");
  assert.equal(decision.rw_rfc056_serving_mode, "off");
  assert.equal(decision.rw_rfc056_query_allowed, false);
  assert.equal(decision.rw_rfc056_serving_authority, "postgres_only");
  assert.equal(
    eventsNamed(events, "inbox.rw.rfc056_serving_guard.shadow_comparison").length,
    0,
  );
});

test("RFC056 shadow mode reads the candidate but always returns and labels Postgres authority", async () => {
  configureFailSoftDeps();
  const { sink, tracer } = makeTraceHarness();
  let rwQueries = 0;
  __testRisingWaveInboxFailSoft.setDeps({
    getRfc056ServingMode: () => "shadow",
    getInboxItemsServingVersion: async () => 2,
    query: async <T extends QueryResultRow = QueryResultRow>() => {
      rwQueries += 1;
      return {
        result: {
          rows: [{
            kind: null,
            readAuthorityPresent: false,
            readAuthoritySeq: 0,
            totalCount: 0,
            totalUnreadCount: 0,
            activeUnreadCount: 0,
          }],
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
        },
        acquireWaitMs: 0,
        poolState: {
          rw_pool_total: 1,
          rw_pool_idle: 1,
          rw_pool_waiting: 0,
        },
      } as unknown as RisingWaveQueryRead<T>;
    },
  });

  const result = await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, () =>
    __testRisingWaveInboxFailSoft.callInboxItemsWrapper(
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      { filter: "all", humanActivityMuteEnabled: false },
    ));

  assert.deepEqual(result, {
    items: [],
    groups: [],
    hasMore: false,
    totalCount: 0,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  });
  assert.equal(rwQueries, 1);
  const events = latestSpanEvents(sink);
  const decision = eventAttrs(events, "inbox.rw.rfc056_serving_guard.decision");
  assert.equal(decision.rw_rfc056_serving_mode, "shadow");
  assert.equal(decision.rw_rfc056_query_allowed, true);
  assert.equal(decision.rw_rfc056_serving_authority, "postgres_only");
  const comparison = eventAttrs(
    events,
    "inbox.rw.rfc056_serving_guard.shadow_comparison",
  );
  assert.equal(comparison.rw_rfc056_comparison, "match");
  assert.equal(comparison.rw_rfc056_authoritative_backend, "pg_legacy");
  const selected = eventsNamed(events, "inbox.backend.selected").at(-1)?.attrs ?? {};
  assert.equal(selected.inbox_backend, "pg_legacy");
  assert.equal(
    selected.inbox_postgres_selection_reason,
    "rfc056_shadow_uses_canonical_pg",
  );
});

test("RFC056 shadow mode keeps Postgres authoritative when the candidate is unavailable", async () => {
  configureFailSoftDeps();
  const { sink, tracer } = makeTraceHarness();
  __testRisingWaveInboxFailSoft.setDeps({
    getRfc056ServingMode: () => "shadow",
    getInboxItemsServingVersion: async () => 2,
    query: async () => {
      throw acquireTimeout();
    },
  });

  const result = await withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, () =>
    __testRisingWaveInboxFailSoft.callInboxItemsWrapper(
      "00000000-0000-4000-8000-000000000031",
      "00000000-0000-4000-8000-000000000032",
      { filter: "all", humanActivityMuteEnabled: false },
    ));

  assert.deepEqual(result.items, []);
  const events = latestSpanEvents(sink);
  const comparison = eventAttrs(
    events,
    "inbox.rw.rfc056_serving_guard.shadow_comparison",
  );
  assert.equal(comparison.rw_rfc056_comparison, "candidate_unavailable");
  const selected = eventsNamed(events, "inbox.backend.selected").at(-1)?.attrs ?? {};
  assert.equal(selected.inbox_backend, "pg_legacy");
  assert.equal(
    selected.inbox_postgres_selection_reason,
    "rfc056_shadow_uses_canonical_pg",
  );
  assert.equal(selected.inbox_fallback_reason, "rw_error");
});

test("RisingWave inbox production wrappers use PG for inbox schema errors but keep legacy count query errors strict", async () => {
  for (const route of ["all", "channel_unread", "sidebar_summary"] as const) {
    __testRisingWaveInboxFailSoft.reset();
    configureFailSoftDeps();
    const pgQueries: string[] = [];
    const traceQuery = makeWrapperTraceQuery(pgQueries);
    const { sink, tracer } = makeTraceHarness();

    __testRisingWaveInboxFailSoft.setDeps({
      getInboxItemsServingVersion: async () => 2,
      getJointStorageServerIds: async () => new Set(),
      query: async () => {
        throw Object.assign(new Error("syntax error"), { code: "42601" });
      },
    });

    const invoke = () => withTraceRoot(tracer, "server.http.request", TEST_ROOT_SPAN, async () => {
        if (route === "all") {
          return __testRisingWaveInboxFailSoft.callInboxItemsWrapper("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", {
            filter: "all",
            traceQuery,
            humanActivityMuteEnabled: false,
          });
        } else if (route === "channel_unread") {
          await __testRisingWaveInboxFailSoft.callUnreadCountsWrapper(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
            undefined,
            { traceQuery },
          );
        } else {
          await __testRisingWaveInboxFailSoft.callSidebarUnreadSummaryCountsWrapper(
            [{ serverId: "00000000-0000-4000-8000-000000000001" }],
            "00000000-0000-4000-8000-000000000002",
            { traceQuery },
          );
        }
      });

    if (route === "all") {
      const result = await invoke();
      assert.deepEqual(result, {
        items: [],
        groups: [],
        hasMore: false,
        totalCount: 0,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
      });
      assert.deepEqual(pgQueries, ["channels.inbox_items_by_user"]);
    } else {
      await assert.rejects(invoke(), /syntax error/);
      assert.deepEqual(pgQueries, []);
    }
    const failed = eventAttrs(latestSpanEvents(sink), "inbox.backend.failed");
    assert.equal(failed.inbox_route, route);
    assert.equal(failed.terminal_status, route === "all" ? undefined : "500");
    assert.equal(failed.fallback_outcome, route === "all" ? undefined : "not_attempted");
  }
});

test("read-frontier validation covers empty pages, cursor consistency, newer activity, follower isolation, and A-B-A generations", () => {
  const row = {
    kind: "channel",
    mentionOnly: false,
    materializedLastReadSeq: 42,
    maxReadSeq: 42,
    readStateVersion: 5,
    readCursorPresent: true,
    readAuthorityPresent: true,
    readAuthoritySeq: 9,
    unreadCount: 1,
  };

  assert.deepEqual(
    __testRisingWaveInboxFailSoft.validateReadFrontier([row], { present: true, seq: 9 }),
    { ok: true },
    "newer messages may increase unread without changing a valid read frontier",
  );
  assert.deepEqual(
    __testRisingWaveInboxFailSoft.validateReadFrontier([{
      kind: null,
      readAuthorityPresent: true,
      readAuthoritySeq: 9,
    }], { present: true, seq: 9 }),
    { ok: true },
    "authority scalar must validate even when pagination returns no items",
  );
  assert.equal(
    __testRisingWaveInboxFailSoft.validateReadFrontier(
      [{ ...row, readAuthoritySeq: 8 }],
      { present: true, seq: 9 },
    ).ok,
    false,
    "an A-B-A cursor value cannot hide the newer authority generation",
  );
  assert.equal(
    __testRisingWaveInboxFailSoft.validateReadFrontier(
      [{ ...row, maxReadSeq: 41 }],
      { present: true, seq: 9 },
    ).ok,
    false,
    "the serving MV and versioned cursor must come from one RW epoch",
  );
  assert.equal(
    __testRisingWaveInboxFailSoft.validateReadFrontier(
      [{ ...row, readCursorPresent: false }],
      { present: true, seq: 9 },
    ).ok,
    false,
    "non-zero read state cannot be accepted without its versioned cursor row",
  );
  assert.deepEqual(
    __testRisingWaveInboxFailSoft.validateReadFrontier(
      [{ ...row, readAuthorityPresent: false, readAuthoritySeq: 0 }],
      { present: false, seq: 0 },
    ),
    { ok: true },
    "a different follower with no authority row remains independently valid",
  );
});

test("HAR parity: a primary read-all frontier cannot be combined with a stale RisingWave unread row", async () => {
  const db = getDb();
  const userId = randomUUID();
  const serverId = randomUUID();
  const channelId = randomUUID();
  const messageId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `rw-read-frontier-${userId}@slock.test`,
    name: `rw-read-frontier-${userId}`,
    passwordHash: "not-used",
  });
  await db.insert(servers).values({
    id: serverId,
    name: "RW read-frontier HAR parity",
    slug: `rw-read-frontier-${serverId}`,
    ownerId: userId,
    plan: "founder",
  });
  await db.insert(channels).values({
    id: channelId,
    serverId,
    name: "rw-read-frontier",
  });
  await db.insert(channelHumans).values({ channelId, userId });
  await db.insert(messages).values({
    id: messageId,
    channelId,
    senderType: "user",
    senderId: userId,
    content: "HAR resurrected row",
  });
  await db.insert(userChannelReadCursors).values({
    userId,
    channelId,
    lastReadSeq: 10_686_605,
    readStateVersion: 7,
    lastAppliedAuthoritySeq: 7,
  });
  await db.insert(readMutationAuthorities).values({
    serverId,
    principalId: userId,
    nextAuthoritySeq: 8,
    lastTerminalAuthoritySeq: 7,
  });

  configureFailSoftDeps();
  __testRisingWaveInboxFailSoft.setDeps({
    getInboxItemsServingVersion: async () => 2,
    query: (async () => ({
      result: {
        rows: [{
          kind: "channel",
          channelId,
          channelName: "rw-read-frontier",
          channelType: "channel",
          lastMessageId: messageId,
          firstUnreadMessageId: messageId,
          firstMentionMessageId: null,
          lastMessageAt: "2026-07-27 01:15:00.000000+00",
          lastMessagePreview: "HAR resurrected row",
          lastMessageSenderType: "user",
          lastMessageSenderId: randomUUID(),
          lastMessageSenderName: "Sender",
          unreadCount: 1,
          hasMention: false,
          mentionOnly: false,
          materializedLastReadSeq: 10_686_604,
          maxReadSeq: 10_686_604,
          readStateVersion: 6,
          readCursorPresent: true,
          readAuthorityPresent: true,
          readAuthoritySeq: 6,
          activityAt: "2026-07-27 01:15:00.000000+00",
          totalCount: 1,
          totalUnreadCount: 1,
          activeUnreadCount: 1,
        }],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      },
      acquireWaitMs: 0,
      poolState: {
        rw_pool_total: 1,
        rw_pool_idle: 1,
        rw_pool_waiting: 0,
      },
    })) as any,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await __testRisingWaveInboxFailSoft.callInboxItemsWrapper(serverId, userId, {
      filter: "unread",
      humanActivityMuteEnabled: false,
    });
    assert.deepEqual(
      snapshot,
      {
        items: [],
        groups: [],
        hasMore: false,
        totalCount: 0,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
      },
      `snapshot ${attempt + 1} must not resurrect an unread row below the acknowledged primary frontier`,
    );
  }

  const allSnapshot = await __testRisingWaveInboxFailSoft.callInboxItemsWrapper(serverId, userId, {
    filter: "all",
    humanActivityMuteEnabled: false,
  });
  assert.equal(allSnapshot.items.length, 1, "whole-request PG fallback must preserve the Activity All row");
  assert.equal(allSnapshot.items[0]?.unreadCount, 0);
  assert.equal(allSnapshot.items[0]?.firstUnreadMessageId, null);
  assert.equal(allSnapshot.items[0]?.maxReadSeq, 10_686_605);
  assert.equal(allSnapshot.items[0]?.readStateVersion, 7);

  await db.update(userChannelReadCursors)
    .set({ lastReadSeq: 10_686_606, readStateVersion: 8 })
    .where(and(
      eq(userChannelReadCursors.userId, userId),
      eq(userChannelReadCursors.channelId, channelId),
    ));
  __testRisingWaveInboxFailSoft.setDeps({
    query: (async () => ({
      result: {
        rows: [{
          kind: "channel",
          channelId,
          channelName: "rw-read-frontier",
          channelType: "channel",
          lastMessageId: messageId,
          firstUnreadMessageId: null,
          firstMentionMessageId: null,
          lastMessageAt: "2026-07-27 01:15:00.000000+00",
          lastMessagePreview: "HAR acknowledged row",
          lastMessageSenderType: "user",
          lastMessageSenderId: userId,
          lastMessageSenderName: "Reader",
          unreadCount: 0,
          hasMention: false,
          mentionOnly: false,
          materializedLastReadSeq: 10_686_605,
          maxReadSeq: 10_686_605,
          readStateVersion: 7,
          readCursorPresent: true,
          readAuthorityPresent: true,
          readAuthoritySeq: 7,
          activityAt: "2026-07-27 01:15:00.000000+00",
          totalCount: 1,
          totalUnreadCount: 0,
          activeUnreadCount: 0,
        }],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      },
      acquireWaitMs: 0,
      poolState: {
        rw_pool_total: 1,
        rw_pool_idle: 1,
        rw_pool_waiting: 0,
      },
    })) as any,
  });
  const { sink, tracer } = makeTraceHarness();
  const acceptedRwSnapshot = await withTraceRoot(
    tracer,
    "server.http.request",
    TEST_ROOT_SPAN,
    () => __testRisingWaveInboxFailSoft.callInboxItemsWrapper(
      serverId,
      userId,
      { filter: "all", humanActivityMuteEnabled: false },
    ),
  );
  assert.equal(acceptedRwSnapshot.items[0]?.unreadCount, 0);
  assert.equal(acceptedRwSnapshot.items[0]?.firstUnreadMessageId, null);
  assert.equal(
    acceptedRwSnapshot.items[0]?.maxReadSeq,
    10_686_605,
    "accepted RW rows must not be decorated with the newer primary cursor",
  );
  assert.equal(acceptedRwSnapshot.items[0]?.readStateVersion, 7);
  const events = latestSpanEvents(sink);
  const decision = eventAttrs(events, "inbox.rw.rfc056_serving_guard.decision");
  assert.equal(decision.rw_rfc056_serving_mode, "on");
  assert.equal(decision.rw_rfc056_query_allowed, true);
  assert.equal(
    decision.rw_rfc056_serving_authority,
    "risingwave_candidate_with_postgres_fallback",
  );
  const selected = eventsNamed(events, "inbox.backend.selected").at(-1)?.attrs ?? {};
  assert.equal(selected.inbox_backend, "rw_mv");
});
