import { eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { oauthClients } from "../../db/schema";
import { currentAppPermissionSet, type AppPermissionSet } from "../../services/appPermissionExpectation";

/** The app's current scopes and groups: what an admin who just loaded the page was shown. */
export async function currentAppPermissions(clientId: string): Promise<AppPermissionSet> {
  const [client] = await getDb().select({
    allowedScopes: oauthClients.allowedScopes,
    outboundCurrentGroups: oauthClients.outboundCurrentGroups,
  }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  if (!client) throw new Error(`OAuth client ${clientId} not found`);
  return currentAppPermissionSet(client);
}

/** Body fields for install / approve-update requests that confirm the app's current set. */
export async function expectedAppPermissionsBody(clientId: string): Promise<{ expected_scopes: string[]; expected_groups: string[] }> {
  const current = await currentAppPermissions(clientId);
  return { expected_scopes: current.scopes, expected_groups: current.groups };
}

/** JSON body for install / approve-update requests that confirm the app's current set. */
export async function expectedAppPermissionsJson(clientId: string): Promise<string> {
  return JSON.stringify(await expectedAppPermissionsBody(clientId));
}
