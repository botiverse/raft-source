import { and, eq } from "drizzle-orm";

import type { DatabaseExecutor } from "../db/index";
import {
  externalAppInstallServerGrants,
  externalAppRegistrations,
  externalAppServerGrants,
} from "../db/schema";

export interface ExternalInstallServerGrantCoordinate {
  installId: string;
  serverId: string;
  registrationId: string;
}

type Association = typeof externalAppInstallServerGrants.$inferSelect;
type Grant = typeof externalAppServerGrants.$inferSelect;

/** A current association is usable only for the registration's current manifest. */
export function grantMatchesCurrentRegistration(
  grant: Grant,
  registration: typeof externalAppRegistrations.$inferSelect,
): boolean {
  const canonical = (values: readonly string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  const actual = canonical(grant.grantedCapabilities);
  const required = canonical(registration.requiredCapabilities);
  return registration.state === "active"
    && grant.registrationId === registration.id
    && grant.grantedManifestVersion === registration.capabilityManifestVersion
    && grant.grantedManifestHash === registration.capabilityManifestHash
    && actual.length === required.length && actual.every((value, index) => value === required[index]);
}

export type ExternalInstallServerGrantAuthorityDecision =
  | { current: false; reason: "missing_or_inactive" }
  | { current: false; reason: "epoch_mismatch"; association: Association; grant: Grant }
  | { current: true; association: Association; grant: Grant };

/**
 * Resolves the one current Raft-server grant attached to a workspace install.
 * Every consumer of the shared-install association must use this complete
 * identity + state + epoch fence before provider I/O or authority mutation.
 */
export async function resolveExternalInstallServerGrantAuthority(
  executor: DatabaseExecutor,
  coordinate: ExternalInstallServerGrantCoordinate,
  options: { lock?: boolean } = {},
): Promise<ExternalInstallServerGrantAuthorityDecision> {
  if (options.lock) return lockExternalInstallServerGrantAuthority(executor, coordinate);
  const query = executor.select({
    association: externalAppInstallServerGrants,
    grant: externalAppServerGrants,
  }).from(externalAppInstallServerGrants)
    .innerJoin(externalAppServerGrants, and(
      eq(externalAppServerGrants.id, externalAppInstallServerGrants.serverGrantId),
      eq(externalAppServerGrants.serverId, externalAppInstallServerGrants.serverId),
      eq(externalAppServerGrants.registrationId, externalAppInstallServerGrants.registrationId),
    ))
    .where(and(
      eq(externalAppInstallServerGrants.installId, coordinate.installId),
      eq(externalAppInstallServerGrants.serverId, coordinate.serverId),
      eq(externalAppInstallServerGrants.registrationId, coordinate.registrationId),
      eq(externalAppInstallServerGrants.state, "active"),
      eq(externalAppServerGrants.state, "active"),
    ))
    .limit(2);
  const rows = await query;
  if (rows.length !== 1) return { current: false, reason: "missing_or_inactive" };
  return decide(rows[0]!);
}

function decide(row: { association: Association; grant: Grant }): ExternalInstallServerGrantAuthorityDecision {
  if (row.association.grantEpoch !== row.grant.grantEpoch) {
    return { current: false, reason: "epoch_mismatch", ...row };
  }
  return { current: true, ...row };
}

// The same rows as the unlocked join, locked one table at a time
// (slackBridgeRowLocks.ts): the install's association, then the server grant.
async function lockExternalInstallServerGrantAuthority(
  executor: DatabaseExecutor,
  coordinate: ExternalInstallServerGrantCoordinate,
): Promise<ExternalInstallServerGrantAuthorityDecision> {
  const associations = await executor.select().from(externalAppInstallServerGrants).where(and(
    eq(externalAppInstallServerGrants.installId, coordinate.installId),
    eq(externalAppInstallServerGrants.serverId, coordinate.serverId),
    eq(externalAppInstallServerGrants.registrationId, coordinate.registrationId),
    eq(externalAppInstallServerGrants.state, "active"),
  )).orderBy(externalAppInstallServerGrants.id).limit(2).for("update");
  if (associations.length !== 1) return { current: false, reason: "missing_or_inactive" };
  const association = associations[0]!;
  const grants = await executor.select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.id, association.serverGrantId),
    eq(externalAppServerGrants.serverId, association.serverId),
    eq(externalAppServerGrants.registrationId, association.registrationId),
    eq(externalAppServerGrants.state, "active"),
  )).limit(2).for("update");
  if (grants.length !== 1) return { current: false, reason: "missing_or_inactive" };
  return decide({ association, grant: grants[0]! });
}

export async function findAnyCurrentExternalInstallServerGrantAuthority(
  executor: DatabaseExecutor,
  input: { installId: string; registrationId: string },
  options: { lock?: boolean } = {},
): Promise<Extract<ExternalInstallServerGrantAuthorityDecision, { current: true }> | null> {
  const query = executor.select({
    serverId: externalAppInstallServerGrants.serverId,
  }).from(externalAppInstallServerGrants).where(and(
    eq(externalAppInstallServerGrants.installId, input.installId),
    eq(externalAppInstallServerGrants.registrationId, input.registrationId),
    eq(externalAppInstallServerGrants.state, "active"),
  ));
  const associations = options.lock
    ? await query.orderBy(externalAppInstallServerGrants.id).for("update")
    : await query;
  for (const association of associations) {
    const decision = await resolveExternalInstallServerGrantAuthority(executor, {
      installId: input.installId,
      serverId: association.serverId,
      registrationId: input.registrationId,
    }, options);
    if (decision.current) return decision;
  }
  return null;
}
