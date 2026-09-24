import assert from "node:assert/strict";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

test("0187 accepts the pre-0187 first-only writer and exposes first as the logical latest pair", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'timezone-rolling-deploy@slock.test',
        'timezone-rolling-deploy',
        'test'
      );

      -- Exact write shape used by the server immediately before 0187: only
      -- the immutable first pair is populated.
      UPDATE "users"
      SET
        "first_observed_timezone" = COALESCE("first_observed_timezone", 'Asia/Shanghai'),
        "first_observed_timezone_at" = COALESCE(
          "first_observed_timezone_at",
          '2026-07-21T12:00:00.000Z'::timestamptz
        )
      WHERE "id" = '11111111-1111-4111-8111-111111111111';
    `);

    const result = await client.query<{
      first_timezone: string;
      last_timezone: string | null;
      last_at: string | null;
      logical_latest_timezone: string;
      logical_as_of_timezone: string | null;
      logical_latest_epoch: number;
    }>(`
      SELECT
        "first_observed_timezone" AS first_timezone,
        "last_observed_timezone" AS last_timezone,
        "last_observed_timezone_at"::text AS last_at,
        COALESCE("last_observed_timezone", "first_observed_timezone") AS logical_latest_timezone,
        CASE
          WHEN "last_observed_timezone_at" <= '2026-07-21T12:01:00.000Z'::timestamptz
            THEN "last_observed_timezone"
          WHEN "first_observed_timezone_at" <= '2026-07-21T12:01:00.000Z'::timestamptz
            THEN "first_observed_timezone"
          ELSE NULL
        END AS logical_as_of_timezone,
        EXTRACT(EPOCH FROM COALESCE(
          "last_observed_timezone_at",
          "first_observed_timezone_at"
        ))::int AS logical_latest_epoch
      FROM "users"
      WHERE "id" = '11111111-1111-4111-8111-111111111111'
    `);

    assert.deepEqual(result.rows, [{
      first_timezone: "Asia/Shanghai",
      last_timezone: null,
      last_at: null,
      logical_latest_timezone: "Asia/Shanghai",
      logical_as_of_timezone: "Asia/Shanghai",
      logical_latest_epoch: 1784635200,
    }]);

    await assert.rejects(
      client.exec(`
        UPDATE "users"
        SET "last_observed_timezone" = 'Europe/London'
        WHERE "id" = '11111111-1111-4111-8111-111111111111'
      `),
      /users_last_timezone_observation_consistent/,
      "a half-populated last pair must remain invalid",
    );
    await assert.rejects(
      client.exec(`
        UPDATE "users"
        SET
          "last_observed_timezone" = ' ',
          "last_observed_timezone_at" = '2026-07-21T12:01:00.000Z'::timestamptz
        WHERE "id" = '11111111-1111-4111-8111-111111111111'
      `),
      /users_last_timezone_observation_consistent/,
      "an empty last timezone must remain invalid",
    );
    await assert.rejects(
      client.exec(`
        UPDATE "users"
        SET
          "last_observed_timezone" = 'Europe/London',
          "last_observed_timezone_at" = '2026-07-21T11:59:00.000Z'::timestamptz
        WHERE "id" = '11111111-1111-4111-8111-111111111111'
      `),
      /users_last_timezone_observation_consistent/,
      "a last observation before first must remain invalid",
    );
  } finally {
    await client.close();
  }
});
