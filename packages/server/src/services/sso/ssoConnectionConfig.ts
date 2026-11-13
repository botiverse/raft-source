/**
 * The non-secret part of a Server's SSO connection (RFC 083 §4), stored as
 * `server_sso_connections.config` / `draft_config`. The OIDC client secret is
 * never here: it is sealed separately (ssoConnectionSecret.ts).
 */
export type SsoProtocol = "oidc" | "saml";

export type OidcConnectionConfig = {
  readonly protocol: "oidc";
  /** The issuer URL; discovery is `<issuer>/.well-known/openid-configuration`. */
  readonly issuer: string;
  readonly clientId: string;
};

export type SamlConnectionConfig = {
  readonly protocol: "saml";
  readonly idpEntityId: string;
  /** The IdP's HTTP-Redirect single sign-on URL. */
  readonly idpSsoUrl: string;
  /** PEM certificates the IdP signs with; two at once during a rotation. */
  readonly idpCertificates: readonly string[];
  /**
   * The owner attests that people cannot change their own email attribute at
   * this IdP, only its administrators can (RFC 083 §5.3). SAML has no
   * `email_verified`; without this, an assertion's email may sign in through
   * an existing link or create a new account, but never take over an
   * existing Raft account by email. Absent on rows saved before it existed:
   * read as false.
   */
  readonly emailManagedByAdmins?: boolean;
};

export type SsoConnectionConfig = OidcConnectionConfig | SamlConnectionConfig;
