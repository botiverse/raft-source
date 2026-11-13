import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanMultiConnectScenario } from "../src/test/jointHumanMultiConnectScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanMultiConnectScenario({ db, seed: createSeed(db) });
  console.log("PASS jointHumanMultiConnectScenario");
} finally {
  await closeTestDatabase();
}
