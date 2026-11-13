import { dbTest } from "../test/integration/dbTest";
import { jointSourceRecoveryPolicyScenario, jointSourceRecoveryScenario } from "../test/jointSourceRecoveryScenario";
import { jointSourceRecoveryPrefilterScenario } from "../test/jointSourceRecoveryPrefilterScenario";

dbTest("joint source recovery (#wg-rbac:#23 policy v3.1): per-tuple outcomes, preview equals apply, one transaction for both tables", async ({ db, seed }) => {
  jointSourceRecoveryPolicyScenario();
  await jointSourceRecoveryScenario({ db, seed });
});

dbTest("joint source recovery scan prefilter: a superset of joints with occurrences (R1, R4 CH and invite), clean joints skipped", async ({ db, seed }) => {
  await jointSourceRecoveryPrefilterScenario({ db, seed });
});
