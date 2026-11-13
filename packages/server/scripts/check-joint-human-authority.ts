import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanAuthorityScenario } from "../src/test/jointHumanAuthorityScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanAuthorityScenario({ db, seed: createSeed(db) });
  console.log("PASS jointHumanAuthorityScenario");
} finally {
  await closeTestDatabase();
}
