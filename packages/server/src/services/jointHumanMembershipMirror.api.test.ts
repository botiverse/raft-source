import { dbTest } from "../test/integration/dbTest";
import { jointHumanMirrorOtherWriters, jointHumanMirrorCreationAndAccept } from "../test/jointHumanMembershipScenarios";
dbTest("joint create and accept commit projection, person and admission together; late failure rolls all three back", async ({ db, seed }) => { await jointHumanMirrorCreationAndAccept({ db, seed }); });
dbTest("mention direct join, source deletion and conversion commit/rollback mirror joint membership atomically", async ({ db, seed }) => { await jointHumanMirrorOtherWriters({ db, seed }); });
