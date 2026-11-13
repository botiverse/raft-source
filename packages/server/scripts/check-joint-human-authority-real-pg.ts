import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanAuthorityConcurrency } from "../src/test/jointHumanAuthorityConcurrency";
const url = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "JOINT_MEMBERSHIP_TEST_DATABASE_URL must name an isolated disposable database",
  );
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
} finally {
  await pool.end();
}
installRisingWaveReadReferences();
const db = await openTestDatabase(url);
try {
  await jointHumanAuthorityConcurrency({ db, seed: createSeed(db) });
  console.log(
    "PASS real PostgreSQL: host identity insert/removal both orders, actor demotion, cross-entry archive ordering",
  );
} finally {
  await closeTestDatabase();
}
