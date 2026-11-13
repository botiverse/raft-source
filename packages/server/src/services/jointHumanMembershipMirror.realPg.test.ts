import { test } from "vitest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db";
import { jointHumanMembershipRouteRace } from "../test/jointHumanMembershipRouteRace";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { jointHumanMembershipConcurrency, jointHumanMembershipPersonScope } from "../test/jointHumanMembershipConcurrency";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
// Runs in `test:joint-source-preview-real-pg` on a random database created from the admin URL.
test.skipIf(skipJointRealPg)("joint source removal, person-scoped locks and HTTP/mention writers serialize on PostgreSQL", async () => {
  await withJointRealPgDatabase("joint_human_membership", async url => {
    installRisingWaveReadReferences(); const app = await openTestApp(url, 0, { taskV2ConversationsFlagDefaultEnabled: true });
    const fixtures = { db: getDb(), seed: createSeed(getDb()) };
    try {
      await jointHumanMembershipConcurrency(fixtures);
      await jointHumanMembershipPersonScope(fixtures);
      await jointHumanMembershipRouteRace({ ...fixtures, baseUrl: app.baseUrl, databaseUrl: url });
    } finally { await app.close(); }
  });
}, 60_000);
