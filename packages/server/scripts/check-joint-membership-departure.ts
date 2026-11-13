import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointMembershipDepartureScenario } from "../src/test/jointMembershipDepartureScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointMembershipDepartureScenario({ db, seed: createSeed(db) });
  console.log(
    "PASS jointMembershipDepartureScenario: fixed victims, late identity, flag rollback, bounded batches, post-commit retry, reconnect barrier",
  );
} finally {
  await closeTestDatabase();
}
