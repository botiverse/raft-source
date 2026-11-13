import { openTestApp } from "../src/test/integration/app";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { jointHostOnlyAuthorityHttpScenario } from "../src/test/jointHostOnlyAuthorityHttpScenario";
installRisingWaveReadReferences();
const app = await openTestApp("pglite://", 0);
try {
  await jointHostOnlyAuthorityHttpScenario(app);
  console.log(
    "PASS actual HTTP: host-only humans, own/foreign agents, row actions, host appointments and entry-scoped labels",
  );
} finally {
  await app.close();
}
