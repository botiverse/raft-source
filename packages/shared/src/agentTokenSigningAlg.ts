/**
 * How Raft signs one App's agent tokens (agent audience JWTs, `typ=at+jwt`).
 *
 * A per-App setting the App's owner or admin chooses, never the token request:
 * ES256 (the default, like every other Raft-signed token) or RS256 for a
 * relying party that accepts only RSA keys (observed: Alibaba Cloud's OIDC
 * identity provider). ID tokens and every Raft callback assertion stay ES256.
 */
export const AGENT_TOKEN_SIGNING_ALGS = ["ES256", "RS256"] as const;

export type AgentTokenSigningAlg = (typeof AGENT_TOKEN_SIGNING_ALGS)[number];

export const DEFAULT_AGENT_TOKEN_SIGNING_ALG: AgentTokenSigningAlg = "ES256";

export function isAgentTokenSigningAlg(value: unknown): value is AgentTokenSigningAlg {
  return typeof value === "string" && (AGENT_TOKEN_SIGNING_ALGS as readonly string[]).includes(value);
}
