import { getDb } from "../src/db";
import { createSeed } from "../src/test/integration/seed";
import { openTestApp } from "../src/test/integration/app";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanWriteConcurrency } from "../src/test/jointHumanWriteConcurrency";
const url = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL;
if (!url) throw new Error("disposable migrated PostgreSQL required");
installRisingWaveReadReferences();
const app = await openTestApp(url, 0);
try {
  const db = getDb();
  await jointHumanWriteConcurrency({
    db,
    seed: createSeed(db),
    baseUrl: app.baseUrl,
  });
  console.log(
    "PASS real PostgreSQL actual HTTP message and task writes versus removal, both commit orders",
  );
} finally {
  await app.close();
}
