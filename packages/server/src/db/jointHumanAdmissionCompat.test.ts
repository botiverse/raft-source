import { dbTest } from "../test/integration/dbTest";
import { jointHumanAdmissionCompatScenario } from "../test/jointHumanAdmissionCompatScenario";
dbTest(
  "cutover mirror and compatible legacy writes share the generation-qualified key",
  async ({ db, seed }) => {
    await jointHumanAdmissionCompatScenario({ db, seed });
  },
);
