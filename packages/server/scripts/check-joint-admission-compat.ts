import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanAdmissionCompatScenario } from "../src/test/jointHumanAdmissionCompatScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanAdmissionCompatScenario({ db, seed: createSeed(db) });
  console.log(
    "PASS cutover mirror and compatible legacy inserts on generation key; old explicit target reproduces failure",
  );
} finally {
  await closeTestDatabase();
}
