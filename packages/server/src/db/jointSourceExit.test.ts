import { dbTest } from "../test/integration/dbTest";
import {
  jointDepartureAuditFlagOffScenario,
  jointSourceExitActivationScenario,
  jointSourceExitDisconnectScenario,
  jointSourceExitHostSideArchiveScenario,
  jointSourceExitLargeDisconnectScenario,
  jointSourceExitLeaveScenario,
  jointSourceExitRetireArchiveAttributionScenario,
  jointSourceExitRollbackScenario,
  jointSourceExitServerDeleteScenario,
} from "../test/jointSourceExitScenario";

dbTest("source exit: leaving or being kicked from the last source server ends J; readers need a live source", async ({ db, seed }) => {
  await jointSourceExitLeaveScenario({ db, seed });
});
dbTest("source exit: a disconnect removes source-less people inline, audited once", async ({ db, seed }) => {
  await jointSourceExitDisconnectScenario({ db, seed });
});
dbTest("source exit: a >128 disconnect is denied at once, batched, and audited once despite a failed batch", async ({ db, seed }) => {
  await jointSourceExitLargeDisconnectScenario({ db, seed });
});
dbTest("source exit: a flag rollback never undoes a pending departure's decision", async ({ db, seed }) => {
  await jointSourceExitRollbackScenario({ db, seed });
});
dbTest("source exit: deleting a server keeps people with a live recovery source elsewhere", async ({ db, seed }) => {
  await jointSourceExitServerDeleteScenario({ db, seed });
});
dbTest("source exit: a participant disconnect that empties the host side queues its archive (<=128)", async ({ db, seed }) => {
  await jointSourceExitHostSideArchiveScenario({ db, seed }, "small");
});
dbTest("source exit: a participant disconnect that empties the host side queues its archive (>128)", async ({ db, seed }) => {
  await jointSourceExitHostSideArchiveScenario({ db, seed }, "large");
});
dbTest("source exit: activation refuses while a member has no live source", async ({ db, seed }) => {
  await jointSourceExitActivationScenario({ db, seed });
});
dbTest("departure audit: a flag-off disconnect audits an actual J removal once, never an entry-only row", async ({ db, seed }) => {
  await jointDepartureAuditFlagOffScenario({ db, seed });
});
dbTest("source exit: deleting a server that empties two host sides attributes each archive to its own last member", async ({ db, seed }) => {
  await jointSourceExitRetireArchiveAttributionScenario({ db, seed });
});
