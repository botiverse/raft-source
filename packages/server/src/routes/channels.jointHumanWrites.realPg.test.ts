import { test } from "vitest";
import { getDb } from "../db";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { jointHumanWriteConcurrency } from "../test/jointHumanWriteConcurrency";
import { jointHumanAuthorityConcurrency } from "../test/jointHumanAuthorityConcurrency";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";

// These scenarios need PostgreSQL lock waiters; PGlite cannot prove ordering.
// Runs in `test:joint-source-preview-real-pg` on a random database created from the admin URL.
test.skipIf(skipJointRealPg)(
  "joint authority and actual writes serialize against removal in both orders",
  async () => {
    await withJointRealPgDatabase("joint_human_writes", async databaseUrl => {
      installRisingWaveReadReferences();
      const app = await openTestApp(databaseUrl, 0);
      try {
        const db = getDb();
        await jointHumanAuthorityConcurrency({ db, seed: createSeed(db) });
        await jointHumanWriteConcurrency({
          db,
          seed: createSeed(db),
          baseUrl: app.baseUrl,
        });
      } finally {
        await app.close();
      }
    });
  },
  90_000,
);
