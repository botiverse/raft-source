/**
 * The edition gate for enterprise SSO (edition.ts): the source-available
 * edition has none. Routes refuse before they read anything
 * (routes/sso.ts refuseWithoutEnterpriseSso); this refuses what arrives below
 * them with an already-issued code, assertion or second-step challenge, so
 * none of it rests on "no start, no code".
 */
import { enterpriseSsoAllowed } from "../../edition";

export class EnterpriseSsoUnavailableError extends Error {
  readonly code = "sso_not_available";
  constructor() {
    super("Single sign-on is not available on this server; sign in with your email and password instead.");
    this.name = "EnterpriseSsoUnavailableError";
  }
}

export function assertEnterpriseSsoAllowed(): void {
  if (!enterpriseSsoAllowed()) throw new EnterpriseSsoUnavailableError();
}
