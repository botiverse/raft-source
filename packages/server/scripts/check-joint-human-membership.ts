import { openTestDatabase, closeTestDatabase } from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanMirrorOtherWriters, jointHumanMirrorCreationAndAccept } from "../src/test/jointHumanMembershipScenarios";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  const fixtures = { db, seed: createSeed(db) };
  for (const scenario of [jointHumanMirrorCreationAndAccept, jointHumanMirrorOtherWriters]) {
    await scenario(fixtures); console.log(`PASS ${scenario.name}`);
  }
} finally { await closeTestDatabase(); }
