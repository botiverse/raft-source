import { getDb } from '../src/db';
import { openTestApp } from '../src/test/integration/app';
import { createSeed } from '../src/test/integration/seed';
import { createHttpClient } from '../src/test/integration/http';
import { installRisingWaveReadReferences } from '../src/test/risingWaveReadReference';
import { setReadPositionSettleMsForTests } from '../src/services/readPositionSettle';
import { dmIdentityRepair, dmMembershipLifecycle, dmPeerAgentPersistence, nonDmSendSkipsPeerQuery } from '../src/test/dmMembershipScenarios';
installRisingWaveReadReferences();
setReadPositionSettleMsForTests(0);
const app = await openTestApp();
const db = getDb();
try {
  const fixtures = {app, db, seed:createSeed(db), http:createHttpClient(app.baseUrl)};
  await dmMembershipLifecycle(fixtures);
  console.log('PASS lifecycle: HTTP read/write/search, cursors, DM/thread recipients');
  await dmIdentityRepair(fixtures);
  console.log('PASS repair: human pair/self/agent, active-only/idempotent/cursors');
  await dmPeerAgentPersistence(fixtures);
  console.log('PASS keyed agent: departed-peer refusal rolls back; rejoin sends; old receipt replays');
  await nonDmSendSkipsPeerQuery(fixtures);
  console.log('PASS non-DM: ordinary/private/thread/task normal/keyed sends and forward execute zero peer queries');
} finally {
  await app.close();
}
