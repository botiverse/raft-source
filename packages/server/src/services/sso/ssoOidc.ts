/**
 * OIDC for a Server's SSO connection (rfcs/083-server-sso.md §5.1, §7):
 * openid-client (an OpenID-certified relying party) over ssoIdpFetch, so
 * discovery and the token endpoint are fetched the SSRF-safe way.
 * Authorization code flow with PKCE (S256), `state` and `nonce`; the ID
 * token's `iss`, `aud`, `azp`, `exp`, `iat`, `nonce` and `sub` are checked by
 * openid-client. The ID token comes straight from the token endpoint over
 * TLS, so its signature is not verified (OIDC Core 3.1.3.7) and JWKS is not
 * fetched. The
 * result is the protocol-neutral SsoProfile; only `email_verified: true`
 * makes the email usable for linking (ssoSignIn.ts).
 */
import * as oidc from "openid-client";
import type { OidcConnectionConfig } from "./ssoConnectionConfig";
import { assertEnterpriseSsoAllowed } from "./ssoEdition";
import { ssoIdpFetch } from "./ssoIdpFetch";
import type { SsoProfile } from "./ssoSignIn";

export const SSO_OIDC_SCOPE = "openid email profile";

const ENTRA_HOST = "login.microsoftonline.com";
const ENTRA_SINGLE_TENANT_PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0\/?$/iu;

/**
 * Microsoft Entra ID (RFC 083 §5.7): the tenant a connection's issuer names,
 * null for a non-Entra issuer, and "multi" for an Entra issuer that names no
 * single tenant (common, organizations, consumers or anything else), which
 * the connection refuses.
 */
export function entraTenantOf(issuer: string): string | "multi" | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== ENTRA_HOST) return null;
  const match = ENTRA_SINGLE_TENANT_PATH.exec(url.pathname);
  return match ? match[1]!.toLowerCase() : "multi";
}

export class SsoOidcError extends Error {
  constructor(readonly code: "discovery_failed" | "exchange_failed" | "claims_missing", message: string) {
    super(message);
    this.name = "SsoOidcError";
  }
}

export type SsoOidcFetch = typeof ssoIdpFetch;

/** The IdP's configuration for this connection; one discovery per sign-in leg. */
export async function discoverOidc(
  config: OidcConnectionConfig,
  clientSecret: string,
  fetchImpl: SsoOidcFetch = ssoIdpFetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<oidc.Configuration> {
  const local = env.RAFT_SSO_ALLOW_HTTP_IDP === "1" && env.NODE_ENV !== "production";
  try {
    return await oidc.discovery(
      new URL(config.issuer),
      config.clientId,
      undefined,
      oidc.ClientSecretPost(clientSecret),
      {
        [oidc.customFetch]: (url: string, options: Parameters<SsoOidcFetch>[1]) => fetchImpl(url, options),
        ...(local && config.issuer.startsWith("http:") ? { execute: [oidc.allowInsecureRequests] } : {}),
      },
    );
  } catch (err) {
    throw new SsoOidcError("discovery_failed", `The identity provider's configuration could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The one-time values a sign-in leg starts with (kept server-side in sso_auth_transactions). */
export async function newOidcChecks(): Promise<{ state: string; nonce: string; codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  return {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier,
    codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
  };
}

export function oidcAuthorizationUrl(
  configuration: oidc.Configuration,
  input: { redirectUri: string; state: string; nonce: string; codeChallenge: string; forceLogin?: boolean },
): URL {
  return oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: input.redirectUri,
    scope: SSO_OIDC_SCOPE,
    response_type: "code",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    ...(input.forceLogin ? { prompt: "login" } : {}),
  });
}

/**
 * Exchanges the callback's code (state, nonce and PKCE checked; the ID token
 * validated) and reads who the IdP says this is. `callbackUrl` is the full
 * URL the IdP redirected to.
 */
export async function completeOidc(
  configuration: oidc.Configuration,
  input: { callbackUrl: URL; state: string; nonce: string; codeVerifier: string; issuer: string },
): Promise<SsoProfile> {
  assertEnterpriseSsoAllowed();
  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
  try {
    tokens = await oidc.authorizationCodeGrant(
      configuration,
      input.callbackUrl,
      // redirect_uri is taken from callbackUrl (the registered callback, without its query).
      { pkceCodeVerifier: input.codeVerifier, expectedState: input.state, expectedNonce: input.nonce, idTokenExpected: true },
    );
  } catch (err) {
    throw new SsoOidcError("exchange_failed", `The identity provider's answer was refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  const claims = tokens.claims();
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  const email = typeof claims?.email === "string" ? claims.email : "";
  if (!subject || !email) throw new SsoOidcError("claims_missing", "The identity provider did not say who this is (sub and email are required)");
  const name = typeof claims?.name === "string" && claims.name.trim() ? claims.name.trim() : null;
  return { subject, email, emailVerified: isEmailVerifiedBy(input.issuer, claims ?? {}), displayName: name, linkByEmail: "link_and_move" };
}

/**
 * Whether the IdP vouches for the email (RFC 083 §5.7). Entra sends no
 * `email_verified`: its email counts only when `xms_edov` is true (the
 * email's domain is owned and verified by that tenant) and the token's `tid`
 * is the tenant the connection names (Tenny dd9301b9). Any other IdP: an
 * explicit `email_verified: true`. `false` never counts.
 */
export function isEmailVerifiedBy(issuer: string, claims: Record<string, unknown>): boolean {
  if (claims.email_verified === false) return false;
  const tenant = entraTenantOf(issuer);
  if (tenant === "multi") return false;
  if (tenant) return claims.xms_edov === true && typeof claims.tid === "string" && claims.tid.toLowerCase() === tenant;
  return claims.email_verified === true;
}
