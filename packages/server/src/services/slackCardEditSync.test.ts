// RFC 082 §4.6: the card update records the Slack edit intent in its own
// transaction; the sync's status is three independent facts.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import {
  externalCardEditSyncs,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
} from "../db/schema";
import { seedSlackCardEditFixture, updateCard, type SlackCardEditFixture as Fixture } from "../test/slackCardEditFixture";
import { recordSlackCardEditIntent, slackCardEditNeedsSend, slackCardEditSyncStatus } from "./slackCardEditSync";

async function syncRow(fixture: Fixture) {
  const [row] = await fixture.db.select().from(externalCardEditSyncs)
    .where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
  return row!;
}

// 1. Intent in the card update's transaction; the frozen snapshot untouched.

test("a card update records the latest revision to sync in its own transaction and leaves the frozen send snapshot alone", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const [before] = await db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, fixture.delivery.id));
  const at = new Date();
  assert.equal(await updateCard(fixture, "Ready for testing", at), 2);
  const sync = await syncRow(fixture);
  assert.equal(sync.latestRevision, 2);
  assert.equal(sync.bindingId, fixture.binding.id);
  assert.equal(sync.bindingEpoch, 1);
  assert.equal(sync.state, "open");
  assert.equal(sync.nextAttemptAt?.getTime(), at.getTime());
  const [after] = await db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, fixture.delivery.id));
  assert.deepEqual(after!.renderSnapshot, before!.renderSnapshot, "the frozen snapshot backs retries and reconciliation");
  assert.equal(after!.renderSnapshotDigest, before!.renderSnapshotDigest);
  assert.equal(after!.reconciliationMarker, before!.reconciliationMarker);

  // The intent commits with the transaction that writes it, or not at all.
  await assert.rejects(db.transaction(async (tx) => {
    await recordSlackCardEditIntent(tx, { messageId: fixture.message.id, revision: 3, now: at });
    throw new Error("rolled back");
  }));
  assert.equal((await syncRow(fixture)).latestRevision, 2);
  await updateCard(fixture, "Approved", at);
  assert.equal((await syncRow(fixture)).latestRevision, 3, "a later update raises the same row");
  assert.equal((await db.select().from(externalCardEditSyncs)).length, 1);
});

test("a card message with no Slack delivery records no intent", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  await db.transaction(async (tx) => {
    await tx.delete(externalMessageLinks);
    await tx.delete(externalDeliveryAttempts);
    await tx.delete(externalOutboundDeliveries);
    await tx.delete(externalDeliveryPartitions);
  });
  await updateCard(fixture, "Ready for testing", new Date());
  assert.deepEqual(await db.select().from(externalCardEditSyncs), []);
});

test("status combines three independent facts and is confirmed only with a definite success of the latest, nothing pending, no unknown", () => {
  const base = { state: "open" as const, endReason: null, latestRevision: 3, shownRevision: 3, succeededRevision: 3,
    refusedRevision: null, uncertainAt: null };
  assert.equal(slackCardEditSyncStatus(base, false).summary, "confirmed");
  assert.equal(slackCardEditSyncStatus(base, true).summary, "pending", "an attempt in flight is pending");
  assert.equal(slackCardEditSyncStatus({ ...base, latestRevision: 4 }, false).summary, "pending");
  const unknown = slackCardEditSyncStatus({ ...base, uncertainAt: new Date() }, false);
  assert.deepEqual(unknown, { uncertain: true, latestResult: "succeeded", pending: false, ended: null, confirmed: false, summary: "not_confirmed" });
  const refused = slackCardEditSyncStatus({ ...base, shownRevision: 2, succeededRevision: 2, refusedRevision: 3, uncertainAt: new Date() }, false);
  assert.deepEqual(refused, { uncertain: true, latestResult: "refused", pending: false, ended: null, confirmed: false, summary: "not_synced" },
    "not synced is shown together with the latch; neither hides the other");
  assert.equal(slackCardEditSyncStatus({ ...base, state: "ended", endReason: "source_deleted" }, false).confirmed, false);
  assert.equal(slackCardEditSyncStatus({ ...base, uncertainAt: new Date(), latestRevision: 4 }, false).summary, "pending",
    "unknown plus pending shows the pending work, never confirmed");
});

test("a refused revision is never sent again; a newer one is, and so is one a read-back found replaced", () => {
  assert.equal(slackCardEditNeedsSend({ latestRevision: 3, shownRevision: 2, refusedRevision: 3 }), false);
  assert.equal(slackCardEditNeedsSend({ latestRevision: 4, shownRevision: 2, refusedRevision: 3 }), true);
  assert.equal(slackCardEditNeedsSend({ latestRevision: 3, shownRevision: 3, refusedRevision: null }), false);
  assert.equal(slackCardEditNeedsSend({ latestRevision: 3, shownRevision: 1, refusedRevision: null }), true, "an older revision showing");
  assert.equal(slackCardEditNeedsSend({ latestRevision: 2, shownRevision: null, refusedRevision: null }), true, "never sent");
});
