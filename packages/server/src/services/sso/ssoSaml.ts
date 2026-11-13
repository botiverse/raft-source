/**
 * SAML 2.0 for a Server's SSO connection (rfcs/083-server-sso.md §5, §7):
 * @node-saml/node-saml (xml-crypto ≥ 6) as the service provider. Raft never
 * parses or verifies XML itself.
 *
 * - SP-initiated only: an AuthnRequest per leg, its ID kept on the leg and
 *   taken once by the response's InResponseTo (validateInResponseTo
 *   "always"). An unsolicited response is never validated (routes/sso.ts
 *   starts a normal leg instead).
 * - The assertion must be signed with one of the connection's IdP
 *   certificates (wantAssertionsSigned), SHA-256 or better; Audience and
 *   Recipient are this connection's SP entity ID and ACS URL; clock skew at
 *   most 3 minutes; each assertion ID accepted once per connection
 *   (saml_assertion_replay).
 * - The subject is the persistent NameID. SAML has no "email verified": the
 *   email counts only because its domain is verified by the Server (§5.7),
 *   and links an existing account only after the owner attested that the
 *   IdP's email attribute is administrator-managed (ssoSignIn.ts).
 */
import { DOMParser } from "@xmldom/xmldom";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile, type SamlConfig } from "@node-saml/node-saml";
import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../../db/index";
import { samlAssertionReplay, ssoAuthTransactions } from "../../db/schema";
import type { SamlConnectionConfig } from "./ssoConnectionConfig";
import { ssoServiceProviderDetails } from "./ssoConnections";
import { assertEnterpriseSsoAllowed } from "./ssoEdition";
import type { SsoProfile } from "./ssoSignIn";

export const SAML_PERSISTENT_NAMEID = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const CLOCK_SKEW_MS = 3 * 60 * 1000;

export type SsoSamlErrorCode = "response_refused" | "weak_signature" | "nameid_not_persistent" | "email_missing" | "email_ambiguous" | "recipient_mismatch";

export class SsoSamlError extends Error {
  constructor(readonly code: SsoSamlErrorCode, message: string) {
    super(message);
    this.name = "SsoSamlError";
  }
}

/**
 * node-saml's cache, bound to one leg and one connection: the leg's request
 * ID is the only one it knows (consumed atomically), and assertion IDs go to
 * the replay table.
 */
function legCache(input: { connectionId: string; legId: string | null; onSave?: (requestId: string) => void }): CacheProvider {
  return {
    async saveAsync(key: string, value: string) {
      input.onSave?.(key);
      return { value, createdAt: Date.now() };
    },
    // node-saml reads the value as the request's creation instant (to expire it).
    async getAsync(key: string) {
      if (!input.legId) return null;
      const [row] = await getDb().select({ createdAt: ssoAuthTransactions.createdAt }).from(ssoAuthTransactions)
        .where(and(eq(ssoAuthTransactions.id, input.legId), eq(ssoAuthTransactions.samlRequestId, key)));
      return row ? row.createdAt.toISOString() : null;
    },
    async removeAsync(key: string | null) {
      if (!input.legId || !key) return null;
      await getDb().update(ssoAuthTransactions).set({ samlRequestId: null })
        .where(and(eq(ssoAuthTransactions.id, input.legId), eq(ssoAuthTransactions.samlRequestId, key)));
      return key;
    },
    async consumeAsync(key: string) {
      if (!input.legId) return null;
      const [row] = await getDb().update(ssoAuthTransactions).set({ samlRequestId: null })
        .where(and(eq(ssoAuthTransactions.id, input.legId), eq(ssoAuthTransactions.samlRequestId, key)))
        .returning({ createdAt: ssoAuthTransactions.createdAt });
      return row ? row.createdAt.toISOString() : null;
    },
    async saveIfAbsentAsync(key: string, _value: string, expiresAtMs: number) {
      return rememberSamlAssertion(input.connectionId, key, expiresAtMs);
    },
  };
}

/**
 * Records an assertion as accepted for this connection; false when it was
 * already (a replay). Defence in depth: InResponseTo is already bound to one
 * leg and consumed once, so a replay over HTTP is refused before this.
 */
export async function rememberSamlAssertion(connectionId: string, key: string, expiresAtMs: number): Promise<boolean> {
  const [row] = await getDb().insert(samlAssertionReplay)
    .values({ connectionId, assertionId: key, expiresAt: new Date(expiresAtMs) })
    .onConflictDoNothing()
    .returning({ id: samlAssertionReplay.assertionId });
  return !!row;
}

function samlFor(connectionId: string, config: SamlConnectionConfig, cacheProvider: CacheProvider): SAML {
  const sp = ssoServiceProviderDetails(connectionId);
  const options: SamlConfig = {
    entryPoint: config.idpSsoUrl,
    // The assertion's Issuer must be this IdP (one key may sign for several entities).
    idpIssuer: config.idpEntityId,
    idpCert: [...config.idpCertificates],
    issuer: sp.samlEntityId,
    audience: sp.samlEntityId,
    callbackUrl: sp.samlAcsUrl,
    identifierFormat: SAML_PERSISTENT_NAMEID,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: "sha256",
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    // Caps how long an assertion is accepted (and kept in the replay table), whatever NotOnOrAfter says.
    maxAssertionAgeMs: 10 * 60 * 1000,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    disableRequestedAuthnContext: true,
    cacheProvider,
  };
  return new SAML(options);
}

/** The IdP redirect for a new leg, and the AuthnRequest ID the leg must store. */
export async function samlAuthorizeUrl(input: {
  connectionId: string;
  config: SamlConnectionConfig;
  relayState: string;
  forceLogin?: boolean;
}): Promise<{ url: string; requestId: string }> {
  let requestId: string | null = null;
  const saml = samlFor(input.connectionId, input.config, legCache({ connectionId: input.connectionId, legId: null, onSave: (id) => { requestId = id; } }));
  if (input.forceLogin) saml.options.forceAuthn = true;
  const url = await saml.getAuthorizeUrlAsync(input.relayState, undefined, {});
  if (!requestId) throw new Error("SAML AuthnRequest has no ID");
  return { url, requestId };
}

const C14N_ALGORITHMS = [
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments",
  "http://www.w3.org/2001/10/xml-exc-c14n#",
  "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
];
/**
 * xml-crypto still accepts SHA-1; RFC 083 §7 does not. Every algorithm a
 * signature names must be on these lists, read from the parsed document
 * (an attribute's entity-encoded form decodes to the same URI; a regex over
 * the raw text would miss it).
 */
const ALLOWED_ALGORITHMS: Record<string, ReadonlySet<string>> = {
  SignatureMethod: new Set([
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    "http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  ]),
  DigestMethod: new Set([
    "http://www.w3.org/2001/04/xmlenc#sha256",
    "http://www.w3.org/2001/04/xmlenc#sha512",
  ]),
  CanonicalizationMethod: new Set(C14N_ALGORITHMS),
  Transform: new Set([...C14N_ALGORITHMS, "http://www.w3.org/2000/09/xmldsig#enveloped-signature"]),
};

function assertStrongSignatures(samlResponse: string): void {
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  let document: Document;
  try {
    // The same parser node-saml and xml-crypto use; any parse error refuses the answer.
    document = new DOMParser({
      errorHandler: {
        warning: () => {},
        error: (message: string) => { throw new Error(message); },
        fatalError: (message: string) => { throw new Error(message); },
      },
    }).parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    throw new SsoSamlError("response_refused", "The SAML response is not well-formed XML");
  }
  if (!document?.documentElement) throw new SsoSamlError("response_refused", "The SAML response is not well-formed XML");
  if (document.doctype) throw new SsoSamlError("response_refused", "The SAML response must not declare a DTD");
  // In any namespace: an element xml-crypto might read under another prefix is checked too.
  for (const [localName, allowed] of Object.entries(ALLOWED_ALGORITHMS)) {
    const elements = document.getElementsByTagNameNS("*", localName);
    for (let i = 0; i < elements.length; i += 1) {
      const algorithm = elements.item(i)?.getAttribute("Algorithm") ?? "";
      if (!allowed.has(algorithm.trim())) {
        throw new SsoSamlError("weak_signature", `The identity provider's ${localName} ${algorithm || "(none)"} is not allowed; sign with SHA-256 or better`);
      }
    }
  }
}

type XmlNode = { _?: string; $?: Record<string, string>; [child: string]: unknown };

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  const value = node?.[name];
  return Array.isArray(value) ? value as XmlNode[] : [];
}

function textOf(node: XmlNode | string | undefined): string | null {
  const text = typeof node === "string" ? node : node?._;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
] as const;
const NAME_ATTRIBUTES = [
  "displayName",
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "http://schemas.microsoft.com/identity/claims/displayname",
] as const;

/** Values of the signed assertion's attributes, by Name (never the profile, where attributes can shadow NameID). */
function attributesOf(assertion: XmlNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const statement of children(assertion, "AttributeStatement")) {
    for (const attribute of children(statement, "Attribute")) {
      const name = attribute.$?.Name;
      if (!name) continue;
      const values = children(attribute, "AttributeValue").map(textOf).filter((value): value is string => value !== null);
      out.set(name, [...(out.get(name) ?? []), ...values]);
    }
  }
  return out;
}

/** Validates the IdP's POSTed SAMLResponse for this leg and reads who it says this is. */
export async function completeSaml(input: {
  connectionId: string;
  legId: string;
  config: SamlConnectionConfig;
  samlResponse: string;
}): Promise<SsoProfile> {
  assertEnterpriseSsoAllowed();
  assertStrongSignatures(input.samlResponse);
  const saml = samlFor(input.connectionId, input.config, legCache({ connectionId: input.connectionId, legId: input.legId }));
  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: input.samlResponse }));
  } catch (err) {
    throw new SsoSamlError("response_refused", `The identity provider's answer was refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!profile?.getAssertion) throw new SsoSamlError("response_refused", "The identity provider signed the person out instead of in");
  // Everything below comes from the signed, verified assertion.
  const assertion = (profile.getAssertion() as { Assertion?: XmlNode }).Assertion;
  const subject = children(assertion, "Subject")[0];
  const nameIdNode = children(subject, "NameID")[0];
  const nameId = textOf(nameIdNode);
  if (!nameId || nameIdNode?.$?.Format !== SAML_PERSISTENT_NAMEID) {
    throw new SsoSamlError("nameid_not_persistent", "The identity provider must send a persistent NameID");
  }
  // A bearer confirmation addressed to this connection's ACS (node-saml only warns about Recipient).
  const acs = ssoServiceProviderDetails(input.connectionId).samlAcsUrl;
  const addressedHere = children(subject, "SubjectConfirmation").some((confirmation) =>
    confirmation.$?.Method === "urn:oasis:names:tc:SAML:2.0:cm:bearer"
    && children(confirmation, "SubjectConfirmationData").some((data) => data.$?.Recipient === acs));
  if (!addressedHere) throw new SsoSamlError("recipient_mismatch", "The assertion is not addressed to this connection");
  const attributes = attributesOf(assertion!);
  let email: string | null = null;
  for (const name of EMAIL_ATTRIBUTES) {
    const values = [...new Set((attributes.get(name) ?? []).map((value) => value.toLowerCase()))];
    if (values.length > 1) throw new SsoSamlError("email_ambiguous", "The identity provider sent more than one email");
    if (values.length === 1) {
      email = values[0]!;
      break;
    }
  }
  if (!email) throw new SsoSamlError("email_missing", "The identity provider did not send an email attribute");
  const displayName = NAME_ATTRIBUTES.map((name) => attributes.get(name)?.[0]).find((value) => !!value) ?? null;
  return {
    subject: nameId,
    email,
    // SAML has no such claim: the verified domain is the anchor (RFC 083 §5.7).
    emailVerified: true,
    displayName,
    linkByEmail: input.config.emailManagedByAdmins === true ? "link" : "none",
  };
}

/** The SP metadata the IdP admin imports (signed requests are not used, so no certificate). */
export function samlServiceProviderMetadata(connectionId: string, config: SamlConnectionConfig): string {
  return samlFor(connectionId, config, legCache({ connectionId, legId: null })).generateServiceProviderMetadata(null, null);
}

/** Hourly maintenance: assertion IDs past the moment they could still be accepted. */
export async function sweepExpiredSamlAssertions(now: Date = new Date()): Promise<number> {
  const removed = await getDb().delete(samlAssertionReplay).where(lte(samlAssertionReplay.expiresAt, now)).returning({ id: samlAssertionReplay.assertionId });
  return removed.length;
}
