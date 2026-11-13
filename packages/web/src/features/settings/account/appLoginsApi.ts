import api from "../../../api/client";

/**
 * One App the person signed in to with their Raft account (account-mode Login
 * with Raft, RFC 079 phase 3a), as GET /api/me/app-logins lists it.
 */
export type AppLogin = {
  id: string;
  /** The App's public client key: what DELETE /api/me/app-logins/:clientId takes. */
  clientId: string;
  name: string;
  logoUrl: string | null;
  scopes: string[];
  grantedAt: string;
};

/** The person's account-mode App logins, newest first. */
export async function listAppLogins(): Promise<AppLogin[]> {
  const { data } = await api.get<AppLogin[]>("/me/app-logins");
  return Array.isArray(data) ? data : [];
}

/** Revokes everything the App holds of the person. Always 204, known App or not. */
export async function revokeAppLogin(clientId: string): Promise<void> {
  await api.delete(`/me/app-logins/${encodeURIComponent(clientId)}`);
}
