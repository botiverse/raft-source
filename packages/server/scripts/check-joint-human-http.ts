import { getDb } from "../src/db";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { openTestApp } from "../src/test/integration/app";
import { jointMembershipDepartureEffects } from "../src/services/jointMembershipDepartureEffects";
import { jointHumanHttpScenario } from "../src/test/jointHumanHttpScenario";
installRisingWaveReadReferences();
const app = await openTestApp("pglite://", 0);
try {
  const db = getDb();
  await jointHumanHttpScenario({
    db,
    seed: createSeed(db),
    baseUrl: app.baseUrl,
    io: app.io,
    departureEffects: jointMembershipDepartureEffects(
      app.app.get("agentOrchestrator"),
    ),
  });
  console.log(
    "PASS jointHumanHttpScenario: actual HTTP, identity privacy, Socket eviction and reconnect",
  );
} finally {
  await app.close();
}
