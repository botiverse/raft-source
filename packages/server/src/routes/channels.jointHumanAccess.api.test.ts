import { apiTest } from "../test/integration/apiTest";
import { jointMembershipDepartureEffects } from "../services/jointMembershipDepartureEffects";
import { jointHumanHttpScenario } from "../test/jointHumanHttpScenario";
apiTest(
  "computed joint HTTP, public identities and live Socket revocation agree",
  async ({ db, seed, app }) => {
    await jointHumanHttpScenario({
      db,
      seed,
      baseUrl: app.baseUrl,
      io: app.io,
      departureEffects: jointMembershipDepartureEffects(
        app.app.get("agentOrchestrator"),
      ),
    });
  },
);
