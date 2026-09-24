import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { externalAppRegistrations, oauthClients } from "../db/schema.js";

/**
 * External-app registrations are the canonical platform lifecycle authority
 * for provider bridges. Their OAuth client is only an identity anchor: Server
 * owners, App maintainers, Marketplace reviewers, and App Notification
 * surfaces must not edit, install, uninstall, rotate, publish, or delete it.
 *
 * Keep this policy derived from the existing restrictive FK. A second mutable
 * "managed" flag would create two authorities which can drift.
 */
export function oauthClientIsPlatformManagedPredicate(): SQL<boolean> {
  return oauthClientIdIsPlatformManagedPredicate(oauthClients.id);
}

export function oauthClientIdIsPlatformManagedPredicate(clientId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${externalAppRegistrations} platform_registration
    where platform_registration.oauth_client_id = ${clientId}
  )`;
}

export function oauthClientIsUserManagedPredicate(): SQL<boolean> {
  return sql<boolean>`not (${oauthClientIsPlatformManagedPredicate()})`;
}

export function oauthClientIdIsUserManagedPredicate(clientId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`not (${oauthClientIdIsPlatformManagedPredicate(clientId)})`;
}
