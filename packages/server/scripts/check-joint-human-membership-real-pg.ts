import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { getDb } from "../src/db";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { openTestApp } from "../src/test/integration/app";
import { jointHumanMembershipRouteRace } from "../src/test/jointHumanMembershipRouteRace";
import { jointHumanMembershipConcurrency, jointHumanMembershipPersonScope } from "../src/test/jointHumanMembershipConcurrency";
// Dedicated disposable database only; this runner installs the full schema.
const url = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL;
if (!url) throw new Error("JOINT_MEMBERSHIP_TEST_DATABASE_URL must name an isolated disposable database");
const pool = new pg.Pool({ connectionString: url, max: 1 });
try { await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) }); }
finally { await pool.end(); }
installRisingWaveReadReferences();
const app = await openTestApp(url, 0, { taskV2ConversationsFlagDefaultEnabled: true });
const db = getDb(); const fixtures = { db, seed: createSeed(db) };
try {
  if (!process.argv.includes("--route-only")) {
    await jointHumanMembershipConcurrency(fixtures);
    console.log("PASS real PostgreSQL: both last-source removal orders serialize; server removal defeats queued backfill");
    await jointHumanMembershipPersonScope(fixtures);
    console.log("PASS real PostgreSQL: departure/role changes lock only the target person's participating joints");
  }
  await jointHumanMembershipRouteRace({ ...fixtures, baseUrl: app.baseUrl, databaseUrl: url });
  console.log("PASS real PostgreSQL: actual HTTP route add and joint task mention add queue without deadlock");
} finally { await app.close(); }
