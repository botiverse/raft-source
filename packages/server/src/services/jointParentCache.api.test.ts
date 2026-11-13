import { dbTest as test } from "../test/integration/dbTest";
import { jointParentCacheScenario } from "../test/jointParentCacheScenarios";

test("validated parent cache gates family readers across upgrades and normal thread writers", async ({ db, seed }) => {
  await jointParentCacheScenario({ db, seed });
});
