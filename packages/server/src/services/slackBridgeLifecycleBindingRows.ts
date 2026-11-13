import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";

import { unionAll } from "drizzle-orm/pg-core";

import type { Database } from "../db/index";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
} from "../db/schema";

/** One indexed snapshot lookup per active binding, never its complete history. */
export function loadSlackBridgeLifecycleBindingRows(db: Database) {
  const latest = db.select({ status: externalBindingAudienceSnapshots.status })
    .from(externalBindingAudienceSnapshots)
    .where(and(
      eq(externalBindingAudienceSnapshots.bindingId, externalChannelBindings.id),
      eq(externalBindingAudienceSnapshots.bindingEpoch, externalChannelBindings.bindingEpoch),
      or(
        ne(externalChannelBindings.privacyClass, "private"),
        isNull(externalChannelBindings.audienceRevision),
        eq(externalChannelBindings.audienceRevision, 0),
      ),
    ))
    .orderBy(desc(externalBindingAudienceSnapshots.audienceRevision))
    .limit(1);
  const pinned = db.select({ status: externalBindingAudienceSnapshots.status })
    .from(externalBindingAudienceSnapshots)
    .where(and(
      eq(externalBindingAudienceSnapshots.bindingId, externalChannelBindings.id),
      eq(externalBindingAudienceSnapshots.bindingEpoch, externalChannelBindings.bindingEpoch),
      eq(externalChannelBindings.privacyClass, "private"),
      gt(externalChannelBindings.audienceRevision, 0),
      eq(externalBindingAudienceSnapshots.audienceRevision, externalChannelBindings.audienceRevision),
    ))
    .limit(1);
  // Mutually exclusive branches keep a private pin in the index condition:
  // an OR with the latest branch would scan history when the pin is missing.
  const snapshot = unionAll(latest, pinned).as("lifecycle_snapshot");

  return db.select({
    bindingId: externalChannelBindings.id,
    bindingState: externalChannelBindings.state,
    bindingEpoch: externalChannelBindings.bindingEpoch,
    installState: externalAppInstalls.state,
    credentialState: externalAppCredentials.state,
    audienceStatus: snapshot.status,
  }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .leftJoin(externalAppCredentials, eq(externalAppCredentials.installId, externalAppInstalls.id))
    .leftJoinLateral(snapshot, sql`true`)
    .where(eq(externalChannelBindings.state, "active"));
}
