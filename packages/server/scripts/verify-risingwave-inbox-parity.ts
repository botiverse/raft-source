#!/usr/bin/env tsx
import { closeDatabase, initDatabase } from "../src/db/index.js";
import {
  getRisingWaveInboxItemsServingVersion,
  queryRisingWave,
  RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
} from "../src/db/risingwave.js";
import {
  __testRisingWaveInboxFailSoft,
  getInboxItems,
  getSidebarUnreadSummaryCounts,
  getUnreadCounts,
  type InboxFilter,
  type InboxItem,
} from "../src/services/channelService.js";

type Options = {
  serverId: string;
  userId: string;
  filters: InboxFilter[];
  limit: number;
  offset: number;
  summaryServerIds: string[];
  bootstrapSeedBaseline: boolean;
};

function usage() {
  console.error([
    "Usage:",
    "  DATABASE_URL=... RISINGWAVE_DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/verify-risingwave-inbox-parity.ts --server-id <uuid> --user-id <uuid> [--filter all,unread,mentions] [--limit 30] [--offset 0] [--summary-server-id <uuid>] [--bootstrap-seed-baseline]",
    "",
    "Compares the canonical inline Postgres fallback path and the code-selected RisingWave serving path for the",
    `unread/inbox backend contract v${RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION}.`,
    "If RISINGWAVE_DATABASE_URL is unset, the script skips with exit 0.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {
    filters: ["all", "unread", "mentions"],
    limit: 30,
    offset: 0,
    summaryServerIds: [],
    bootstrapSeedBaseline: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--user-id" && argv[i + 1]) {
      options.userId = argv[++i];
      continue;
    }
    if (arg === "--filter" && argv[i + 1]) {
      const filters = argv[++i].split(",").map((value) => value.trim()).filter(Boolean);
      options.filters = filters.map((filter) => {
        if (filter === "all" || filter === "unread" || filter === "mentions") return filter;
        throw new Error(`Unsupported RW parity filter: ${filter}. Use all/unread/mentions.`);
      });
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Math.min(Math.max(Number(argv[++i]) || 30, 1), 100);
      continue;
    }
    if (arg === "--offset" && argv[i + 1]) {
      options.offset = Math.max(Number(argv[++i]) || 0, 0);
      continue;
    }
    if (arg === "--summary-server-id" && argv[i + 1]) {
      options.summaryServerIds!.push(argv[++i]);
      continue;
    }
    if (arg === "--bootstrap-seed-baseline") {
      options.bootstrapSeedBaseline = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.serverId || !options.userId) {
    usage();
    throw new Error("--server-id and --user-id are required");
  }
  if (options.summaryServerIds!.length === 0) {
    options.summaryServerIds = [options.serverId];
  }

  return options as Options;
}

function itemKey(item: InboxItem): string {
  if (item.kind === "thread") {
    return `thread:${item.threadChannelId}:${item.parentMessageId}`;
  }
  return `${item.kind}:${item.channelId}`;
}

function comparableItems(items: InboxItem[]): Array<InboxItem & { key: string }> {
  // CONTRACT: This intentionally compares the full UI-visible InboxItem
  // payload, not just row keys. SYNC REQUIRED: when InboxItem changes, keep this
  // deep-equal strict unless there is an explicit product decision to tolerate a
  // field difference between PG inline SQL and RW MV.
  return items.map((item) => ({
    ...item,
    // Keep an explicit key in the diff output so mismatched rows are easier to
    // locate while still comparing the full UI-visible payload.
    key: itemKey(item),
  }));
}

function assertDeepEqual(label: string, actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label} mismatch\nPG: ${expectedJson}\nRW: ${actualJson}`);
  }
}

async function withRisingWaveEnv<T>(risingWaveUrl: string | undefined, enabled: boolean, work: () => Promise<T>): Promise<T> {
  const previous = process.env.RISINGWAVE_DATABASE_URL;
  if (enabled) {
    if (risingWaveUrl) process.env.RISINGWAVE_DATABASE_URL = risingWaveUrl;
  } else {
    delete process.env.RISINGWAVE_DATABASE_URL;
  }

  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.RISINGWAVE_DATABASE_URL;
    else process.env.RISINGWAVE_DATABASE_URL = previous;
  }
}

async function main() {
  const inboxItemsVersion = getRisingWaveInboxItemsServingVersion();
  const risingWaveUrl = process.env.RISINGWAVE_DATABASE_URL?.trim();
  if (!risingWaveUrl) {
    console.log(JSON.stringify({
      skipped: true,
      reason: "RISINGWAVE_DATABASE_URL is not configured",
      contractVersion: RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
      rwInboxItemsVersion: inboxItemsVersion,
    }, null, 2));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required when RISINGWAVE_DATABASE_URL is configured");
  }

  const options = parseArgs(process.argv.slice(2));
  // A successful process exit is not enough: the production wrappers
  // intentionally fail soft to Postgres on RW connection failures. Count only
  // completed direct RW queries and require each "RW" comparison leg to have
  // actually reached RisingWave.
  let successfulRisingWaveQueries = 0;
  __testRisingWaveInboxFailSoft.reset();
  __testRisingWaveInboxFailSoft.setDeps({
    query: async (pool, queryText, values) => {
      const result = await queryRisingWave(pool, queryText, values);
      successfulRisingWaveQueries += 1;
      return result;
    },
  });
  const strictRisingWaveRead = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const before = successfulRisingWaveQueries;
    const result = await work();
    if (successfulRisingWaveQueries === before) {
      throw new Error(`${label} did not complete a direct RisingWave query (fail-soft fallback is not parity)`);
    }
    return result;
  };
  await initDatabase(databaseUrl, process.env.DATABASE_URL_READ_REPLICA);
  try {
    const inboxResults = [];
    for (const filter of options.filters) {
      // CONTRACT: disabled RW env exercises canonical inline Postgres SQL;
      // enabled RW env exercises the rw_* materialized views. These two outputs
      // must stay equivalent before RISINGWAVE_DATABASE_URL is enabled.
      const pg = await withRisingWaveEnv(risingWaveUrl, false, () => getInboxItems(options.serverId, options.userId, {
        filter,
        limit: options.limit,
        offset: options.offset,
        // Fresh raftdev seed has no suppression/mute fixtures and the server's
        // derived inbox_serving_rows projector has not started yet. Compare the
        // canonical inline PG contract to the versioned RW graph at bootstrap;
        // normal/manual parity keeps current mute-aware serving semantics.
        ...(options.bootstrapSeedBaseline ? { humanActivityMuteEnabled: false } : {}),
      }));
      const rw = await strictRisingWaveRead(`inbox ${filter}`, () =>
        withRisingWaveEnv(risingWaveUrl, true, () => getInboxItems(options.serverId, options.userId, {
          filter,
          limit: options.limit,
          offset: options.offset,
          ...(options.bootstrapSeedBaseline ? { humanActivityMuteEnabled: false } : {}),
        })),
      );

      assertDeepEqual(`inbox ${filter} totalCount`, rw.totalCount, pg.totalCount);
      assertDeepEqual(`inbox ${filter} totalUnreadCount`, rw.totalUnreadCount, pg.totalUnreadCount);
      assertDeepEqual(`inbox ${filter} activeUnreadCount`, rw.activeUnreadCount, pg.activeUnreadCount);
      assertDeepEqual(`inbox ${filter} hasMore`, rw.hasMore, pg.hasMore);
      assertDeepEqual(`inbox ${filter} items`, comparableItems(rw.items), comparableItems(pg.items));

      inboxResults.push({
        filter,
        rows: rw.items.length,
        totalCount: rw.totalCount,
        totalUnreadCount: rw.totalUnreadCount,
        activeUnreadCount: rw.activeUnreadCount,
      });
    }

    const summaryInputs = options.summaryServerIds.map((serverId) => ({ serverId }));
    const pgSummary = await withRisingWaveEnv(risingWaveUrl, false, () =>
      getSidebarUnreadSummaryCounts(summaryInputs, options.userId),
    );
    const rwSummary = await strictRisingWaveRead("sidebar unread summary", () =>
      withRisingWaveEnv(risingWaveUrl, true, () =>
        getSidebarUnreadSummaryCounts(summaryInputs, options.userId),
      ),
    );
    assertDeepEqual("sidebar unread summary", rwSummary, pgSummary);

    // CONTRACT: /api/channels/unread has a dedicated RW MV because its serving
    // semantics include non-joined public channel unread and followed thread
    // unread with parent access checks. Keep this strict equality in sync with
    // getUnreadCounts and the code-selected rw_channel_unread_counts_* serving MV.
    const pgChannelUnread = await withRisingWaveEnv(risingWaveUrl, false, () =>
      getUnreadCounts(options.serverId, options.userId),
    );
    const rwChannelUnread = await strictRisingWaveRead("channel unread counts", () =>
      withRisingWaveEnv(risingWaveUrl, true, () =>
        getUnreadCounts(options.serverId, options.userId),
      ),
    );
    assertDeepEqual("channel unread counts", rwChannelUnread, pgChannelUnread);

    console.log(JSON.stringify({
      ok: true,
      contractVersion: RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
      rwInboxItemsVersion: inboxItemsVersion,
      serverId: options.serverId,
      userId: options.userId,
      inbox: inboxResults,
      summaryServerIds: options.summaryServerIds,
      channelUnreadCount: Object.keys(rwChannelUnread).length,
      bootstrapSeedBaseline: options.bootstrapSeedBaseline,
      strictRisingWaveQueries: successfulRisingWaveQueries,
    }, null, 2));
  } finally {
    __testRisingWaveInboxFailSoft.reset();
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
