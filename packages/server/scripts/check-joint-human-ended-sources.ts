import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHumanEndedSourceScenario } from "../src/test/jointHumanEndedSourceScenario";
installRisingWaveReadReferences();
const db = await openTestDatabase();
try {
  await jointHumanEndedSourceScenario({ db, seed: createSeed(db) });
  console.log(
    "PASS ended source: leave/rejoin, guest/promotion, disconnect/reconnect, host candidate, fresh generation",
  );
} finally {
  await closeTestDatabase();
}
