import api from "../../../api/client";

/**
 * A Server's SSO settings (rfcs/083-server-sso.md §4–§6) as
 * /api/servers/:id/sso answers them (`serverSsoConnectionView` and
 * `serverSsoDomainView` in packages/server/src/services/sso/). The connection
 * and the rules are the owner's; domains are the owners' and admins'.
 */

export type SsoProtocol = "oidc" | "saml";
export type SsoConnectionStatus = "draft" | "active" | "disabled";

export type SsoCertificateView = {
  pem: string;
  /** Null when a stored certificate no longer parses (`readable: false`). */
  subject: string | null;
  notAfter: string | null;
  readable: boolean;
};

export type SsoOidcConfigView = { protocol: "oidc"; issuer: string; clientId: string };
export type SsoSamlConfigView = {
  protocol: "saml";
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificates: SsoCertificateView[];
  /** Whether only the IdP's administrators can change a person's email; absent from servers that don't send it yet. */
  emailManagedByAdmins?: boolean;
};
export type SsoConfigView = SsoOidcConfigView | SsoSamlConfigView;

/** What the IdP admin pastes on their side (RFC 083 §5.1). */
export type SsoServiceProviderDetails = {
  oidcRedirectUri: string;
  samlEntityId: string;
  samlAcsUrl: string;
  samlMetadataUrl: string;
};

export type SsoRules = { autoJoin: boolean; required: boolean; sessionMaxAgeDays: number };

export type SsoConnectionView = {
  id: string;
  status: SsoConnectionStatus;
  displayName: string;
  config: SsoConfigView;
  /** Never the secret itself: only whether one is stored. */
  hasClientSecret: boolean;
  /** An active connection's saved edit, live after a successful test sign-in. */
  draft: { config: SsoConfigView; replacesClientSecret: boolean } | null;
  rules: SsoRules;
  lastTestedAt: string | null;
  serviceProvider: SsoServiceProviderDetails;
};

export type SsoDomainCheckResult = "present" | "absent" | "lookup_failed";

export type SsoDomainView = {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckResult: SsoDomainCheckResult | null;
  /** The DNS record that proves the domain. */
  record: { type: "TXT"; name: string; value: string };
};

export type ServerSsoSettings = {
  connection: SsoConnectionView | null;
  domains: SsoDomainView[];
  canManageConnection: boolean;
  canManageDomains: boolean;
  /** The platform reviewed this organization (`server_sso_required_v1`): Require SSO can be on and takes effect. Absent from an older server: reviewed. */
  requireReviewed?: boolean;
  secretStoreConfigured: boolean;
};

/** PUT /connection's body. An OIDC edit without `clientSecret` keeps the stored one. */
export type SsoConnectionInput =
  | { protocol: "oidc"; displayName: string; issuer: string; clientId: string; clientSecret?: string }
  | {
    protocol: "saml";
    displayName: string;
    idpEntityId: string;
    idpSsoUrl: string;
    idpCertificates: string[];
    emailManagedByAdmins: boolean;
  };

function responseStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/** The server's own message, or `fallback`. */
export function ssoErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * The Server's SSO settings, or null when there is nothing to show: 404 while
 * `server_sso_v1` is off for the Server, 403 for a member who is not an admin,
 * or an answer not shaped like the settings (an older server, a stub).
 * Anything else throws.
 */
export async function getServerSso(serverId: string): Promise<ServerSsoSettings | null> {
  try {
    const { data } = await api.get<ServerSsoSettings>(`/servers/${serverId}/sso`);
    return data && typeof data === "object" && Array.isArray(data.domains) ? data : null;
  } catch (error) {
    const status = responseStatus(error);
    if (status === 404 || status === 403) return null;
    throw error;
  }
}

export async function saveSsoConnection(serverId: string, input: SsoConnectionInput): Promise<SsoConnectionView> {
  const { data } = await api.put<{ connection: SsoConnectionView }>(`/servers/${serverId}/sso/connection`, input);
  return data.connection;
}

export async function deleteSsoConnection(serverId: string): Promise<void> {
  await api.delete(`/servers/${serverId}/sso/connection`);
}

/** The owner's test sign-in: where to send the browser (the IdP round-trip comes back with `?sso_test=`). */
export async function startSsoTest(serverId: string): Promise<string> {
  const { data } = await api.post<{ url: string; testsDraft: boolean }>(`/servers/${serverId}/sso/test`);
  return data.url;
}

/** Changes only the rules named. */
export async function updateSsoRules(serverId: string, rules: Partial<SsoRules>): Promise<SsoConnectionView> {
  const { data } = await api.patch<{ connection: SsoConnectionView }>(`/servers/${serverId}/sso/rules`, rules);
  return data.connection;
}

export async function addSsoDomain(serverId: string, domain: string): Promise<SsoDomainView> {
  const { data } = await api.post<{ domain: SsoDomainView }>(`/servers/${serverId}/sso/domains`, { domain });
  return data.domain;
}

export async function verifySsoDomain(serverId: string, domainId: string): Promise<SsoDomainView> {
  const { data } = await api.post<{ domain: SsoDomainView; result: SsoDomainCheckResult }>(
    `/servers/${serverId}/sso/domains/${domainId}/verify`,
  );
  return data.domain;
}

export async function removeSsoDomain(serverId: string, domainId: string): Promise<void> {
  await api.delete(`/servers/${serverId}/sso/domains/${domainId}`);
}
