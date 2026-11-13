import { createApiTest } from "../test/integration/apiTest";
import { jointHostOnlyAuthorityHttpScenario } from "../test/jointHostOnlyAuthorityHttpScenario";
const test = createApiTest();
test("joint member management follows host-only human and own-server agent authority", async ({
  app,
}) => {
  await jointHostOnlyAuthorityHttpScenario(app);
});
