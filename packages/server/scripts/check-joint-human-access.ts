import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanAccessScenario } from "../src/test/jointHumanAccessScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanAccessScenario({ db, seed: createSeed(db) });
  console.log("PASS jointHumanAccessScenario");
} finally {
  await closeTestDatabase();
}
