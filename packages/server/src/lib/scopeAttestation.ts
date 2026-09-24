import { createHmac, timingSafeEqual } from "node:crypto";

export interface ScopeAttestationClaims {
  v: 1;
  typ: "scope-attestation";
  scope: string;
  sub: string;
  actorType?: "user" | "machine";
  email?: string | null;
  machineId?: string | null;
  serverId: string;
  serverSlug?: string | null;
  aud?: string | null;
  resource?: string | null;
  metadata?: Record<string, unknown>;
  nonce: string;
  jti?: string;
  exp: number;
}

function getScopeAttestationSecret() {
  const secret = process.env.SCOPE_ATTESTATION_SECRET;
  if (!secret) {
    throw new Error("Scope attestation is not configured");
  }
  return secret;
}

export function createScopeAttestation(claims: ScopeAttestationClaims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", getScopeAttestationSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyScopeAttestation(token: string): ScopeAttestationClaims | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;

  const payload = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);

  const expected = createHmac("sha256", getScopeAttestationSecret())
    .update(payload)
    .digest("base64url");

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const claims: ScopeAttestationClaims = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );
    if (claims.exp && Date.now() / 1000 > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
