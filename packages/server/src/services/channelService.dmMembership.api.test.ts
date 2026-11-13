import { apiTest } from "../test/integration/apiTest";
import { dbTest } from "../test/integration/dbTest";
import { dmIdentityRepair, dmMembershipLifecycle, dmPeerAgentPersistence, nonDmSendSkipsPeerQuery } from "../test/dmMembershipScenarios";

// DM identity outlives server membership; access and delivery do not.
apiTest("remove/rejoin preserves DM history and read position while denying departed users reads, sends and notifications", dmMembershipLifecycle);
dbTest("DM identity reuse repairs only current server members, without resetting cursors or existing participant metadata", dmIdentityRepair);

apiTest("keyed agent DM writes refuse a departed human and preserve committed replay receipts", dmPeerAgentPersistence);

apiTest("ordinary/private/thread/task sends and forwards execute zero DM peer queries", nonDmSendSkipsPeerQuery);
