import { dbTest } from "../test/integration/dbTest";
import { jointSourcePolicyScenario, jointSourcePreviewScenario } from "../test/jointSourcePreviewScenario";

dbTest("joint source preview classifies (J,user,generation,server) read-only", async ({ db, seed }) => {
  jointSourcePolicyScenario();
  await jointSourcePreviewScenario({ db, seed });
});
