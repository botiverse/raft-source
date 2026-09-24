import assert from "node:assert/strict";
import { test } from "vitest";
import { closeDatabase, initDatabase } from "../db/index.js";
import { queryRisingWave } from "../db/risingwave.js";
import { __testRisingWaveInboxFailSoft } from "./channelService.js";

const required = process.env.RISINGWAVE_INBOX_PREPARE_REAL_RW_REQUIRED === "1";
const databaseUrl = process.env.DATABASE_URL?.trim();
const risingWaveUrl = process.env.RISINGWAVE_DATABASE_URL?.trim();
const serverId = process.env.RISINGWAVE_INBOX_PREPARE_SERVER_ID?.trim();
const userId = process.env.RISINGWAVE_INBOX_PREPARE_USER_ID?.trim();
const channelId = process.env.RISINGWAVE_INBOX_PREPARE_CHANNEL_ID?.trim();
const configured = Boolean(databaseUrl && risingWaveUrl && serverId && userId && channelId);

if (required && !configured) {
  throw new Error(
    "real RW prepare test requires DATABASE_URL, RISINGWAVE_DATABASE_URL, "
      + "RISINGWAVE_INBOX_PREPARE_SERVER_ID, RISINGWAVE_INBOX_PREPARE_USER_ID, "
      + "and RISINGWAVE_INBOX_PREPARE_CHANNEL_ID",
  );
}

test("real RisingWave prepares the inbox serving query with null and non-null channelId", {
  skip: !configured,
}, async () => {
  assert.ok(databaseUrl);
  assert.ok(serverId);
  assert.ok(userId);
  assert.ok(channelId);

  const prepared: Array<{ channelParam: unknown; rowCount: number | null }> = [];
  __testRisingWaveInboxFailSoft.setDeps({
    getRfc056ServingMode: () => "on",
    query: async (pool, queryText, values) => {
      const result = await queryRisingWave(pool, queryText, values);
      prepared.push({
        channelParam: values?.[4] ?? null,
        rowCount: result.result.rowCount,
      });
      return result;
    },
  });

  await initDatabase(databaseUrl);
  try {
    for (const scopedChannelId of [undefined, channelId]) {
      await __testRisingWaveInboxFailSoft.callInboxItemsWrapper(serverId, userId, {
        filter: "all",
        limit: 100,
        channelId: scopedChannelId,
        humanActivityMuteEnabled: false,
      });
    }
  } finally {
    __testRisingWaveInboxFailSoft.reset();
    await closeDatabase();
  }

  assert.equal(prepared.length, 2, "both calls must complete a direct RisingWave query");
  assert.equal(prepared[0]?.channelParam, null);
  assert.equal(prepared[1]?.channelParam, channelId);
  assert.ok((prepared[0]?.rowCount ?? 0) >= 1);
  assert.ok((prepared[1]?.rowCount ?? 0) >= 1);
});
