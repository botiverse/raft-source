import type { SsoConfigView, SsoConnectionInput, SsoConnectionView, SsoProtocol } from "./ssoApi";

/** The connection form's fields; both protocols' are kept so switching back loses nothing. */
export type SsoConnectionForm = {
  protocol: SsoProtocol;
  displayName: string;
  issuer: string;
  clientId: string;
  /** Write-only: empty keeps the stored secret. */
  clientSecret: string;
  idpEntityId: string;
  idpSsoUrl: string;
  /** One or two PEM certificates (two while rotating). */
  idpCertificates: string[];
  emailManagedByAdmins: boolean;
};

export const SSO_MAX_CERTIFICATES = 2;

/**
 * The config the owner is editing: an active connection's pending draft when
 * it has one (what a test sign-in would make live), else its config.
 */
export function editedSsoConfig(connection: SsoConnectionView): SsoConfigView {
  return connection.draft?.config ?? connection.config;
}

export function ssoConnectionFormFrom(connection: SsoConnectionView | null, defaultDisplayName: string): SsoConnectionForm {
  const form: SsoConnectionForm = {
    protocol: "oidc",
    displayName: connection?.displayName ?? defaultDisplayName,
    issuer: "",
    clientId: "",
    clientSecret: "",
    idpEntityId: "",
    idpSsoUrl: "",
    idpCertificates: [""],
    emailManagedByAdmins: false,
  };
  if (!connection) return form;
  const config = editedSsoConfig(connection);
  if (config.protocol === "oidc") {
    return { ...form, protocol: "oidc", issuer: config.issuer, clientId: config.clientId };
  }
  return {
    ...form,
    protocol: "saml",
    idpEntityId: config.idpEntityId,
    idpSsoUrl: config.idpSsoUrl,
    idpCertificates: config.idpCertificates.length > 0 ? config.idpCertificates.map((certificate) => certificate.pem) : [""],
    emailManagedByAdmins: config.emailManagedByAdmins === true,
  };
}

/** PUT /connection's body: only the chosen protocol's fields, and the secret only when one was typed. */
export function ssoConnectionInputFrom(form: SsoConnectionForm): SsoConnectionInput {
  const displayName = form.displayName.trim();
  if (form.protocol === "oidc") {
    return {
      protocol: "oidc",
      displayName,
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      // Not trimmed: a secret's edge whitespace may be part of it (as the server reads it).
      ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret } : {}),
    };
  }
  return {
    protocol: "saml",
    displayName,
    idpEntityId: form.idpEntityId.trim(),
    idpSsoUrl: form.idpSsoUrl.trim(),
    idpCertificates: form.idpCertificates.map((pem) => pem.trim()).filter(Boolean),
    emailManagedByAdmins: form.emailManagedByAdmins,
  };
}

export function sameSsoConnectionForm(a: SsoConnectionForm, b: SsoConnectionForm): boolean {
  return JSON.stringify(ssoConnectionInputFrom(a)) === JSON.stringify(ssoConnectionInputFrom(b));
}

/** Whether every field the chosen protocol needs is filled (an OIDC secret can follow later; testing needs it). */
export function ssoConnectionFormComplete(form: SsoConnectionForm): boolean {
  if (!form.displayName.trim()) return false;
  if (form.protocol === "oidc") return Boolean(form.issuer.trim() && form.clientId.trim());
  return Boolean(form.idpEntityId.trim() && form.idpSsoUrl.trim() && form.idpCertificates.some((pem) => pem.trim()));
}

/** Microsoft Entra ID, whose email needs the `xms_edov` claim and a tenant-specific issuer (RFC 083 §5.7). */
export function isEntraIssuer(issuer: string): boolean {
  try {
    return new URL(issuer.trim()).hostname.toLowerCase() === "login.microsoftonline.com";
  } catch {
    return false;
  }
}
