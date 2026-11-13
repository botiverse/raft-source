import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanDepartureKickScenario } from "../src/test/jointHumanDepartureKickScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanDepartureKickScenario({ db, seed: createSeed(db) });
  console.log(
    "PASS post-commit departure kick: channel/server leave and guest demotion; rollback and nested transaction boundaries",
  );
} finally {
  await closeTestDatabase();
}
