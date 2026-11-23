/**
 * The JOSE `typ` header Raft writes on one App's agent tokens (agent audience
 * JWTs).
 *
 * A per-App setting the App's owner or admin chooses, never the token request:
 * `at+jwt` (the default, RFC 9068) or `JWT` for a relying party that refuses
 * any other type (observed: Alibaba Cloud STS AssumeRoleWithOIDC, "Token type
 * is not jwt"). Nothing else in the header or the claims changes.
 *
 * `at+jwt` is what keeps an agent token from being taken for an ID token, which
 * carries the same `aud` (the App's client id) and `typ: JWT`. So `JWT` is
 * allowed only on an App nobody can sign in to: one without a redirect URL
 * (a token-only App). The server refuses `JWT` on an App with a redirect URL,
 * and a redirect URL on an App whose agent token type is `JWT`; the database
 * holds the same rule (oauth_clients_agent_token_type_token_only).
 */
export const AGENT_TOKEN_TYPES = ["at+jwt", "JWT"] as const;

export type AgentTokenType = (typeof AGENT_TOKEN_TYPES)[number];

export const DEFAULT_AGENT_TOKEN_TYPE: AgentTokenType = "at+jwt";

/** Exactly one of AGENT_TOKEN_TYPES, case and all: `jwt` or `at+JWT` is not one. */
export function isAgentTokenType(value: unknown): value is AgentTokenType {
  return typeof value === "string" && (AGENT_TOKEN_TYPES as readonly string[]).includes(value);
}
