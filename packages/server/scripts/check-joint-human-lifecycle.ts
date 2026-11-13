import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanLifecycleScenario } from "../src/test/jointHumanLifecycleScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanLifecycleScenario({ db, seed: createSeed(db) });
  console.log("PASS jointHumanLifecycleScenario");
} finally {
  await closeTestDatabase();
}
