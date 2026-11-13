import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../db/index";
import { userLegalAcceptances } from "../db/schema";
import { CURRENT_LEGAL_ACCEPTANCE, currentDate } from "@botiverse/raft-shared";

export type LegalAcceptanceSource = "signup" | "oauth" | "invite";

export interface LegalAcceptanceInput {
  acceptTerms?: boolean;
  termsVersion?: string;
  privacyVersion?: string;
}

export interface LegalAcceptanceMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
  locale?: string | null;
}

export class LegalAcceptanceRequiredError extends Error {
  constructor() {
    super("LEGAL_ACCEPTANCE_REQUIRED");
    this.name = "LegalAcceptanceRequiredError";
  }
}

export class TermsChangedError extends Error {
  constructor() {
    super("TERMS_CHANGED");
    this.name = "TermsChangedError";
  }
}

function hashEvidence(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The privacy version before CURRENT, still accepted at signup for a grace
 * window (Tenny, 2026-10-14): a page loaded before the bump (an old tab, or web
 * deployed after the server) still sends it, and a strict check would make
 * every such signup fail until a reload. That page showed the old consent
 * line, without the usage-data clause, so such a signup records the version it
 * actually saw and starts with "Share usage data" explicitly off.
 *
 * Until 2026-12-31 (Tenny, 2026-10-21), not a week: the mobile apps send
 * "2026-05-12" as a fixed value, and people keep an old app version long after
 * the fixed one ships, so a short window would stop them signing up. A signup
 * in the window never shares by default, so the longer window costs no
 * privacy. After it, the old version is refused as before.
 */
export const PREVIOUS_PRIVACY_VERSION = "2026-05-12";
const PREVIOUS_PRIVACY_VERSION_ACCEPTED_UNTIL = new Date("2026-12-31T00:00:00.000Z");
let previousPrivacyVersionAcceptedUntil = PREVIOUS_PRIVACY_VERSION_ACCEPTED_UNTIL;

export interface AcceptedLegalVersions {
  termsVersion: string;
  privacyVersion: string;
  /** False when the signup page predates the usage-data clause. */
  sawUsageDataNotice: boolean;
}

export function requireCurrentLegalAcceptance(
  input: LegalAcceptanceInput | undefined,
  now: Date = currentDate(),
): AcceptedLegalVersions {
  if (!input?.acceptTerms) {
    throw new LegalAcceptanceRequiredError();
  }
  if (input.termsVersion !== CURRENT_LEGAL_ACCEPTANCE.termsVersion) {
    throw new TermsChangedError();
  }
  if (input.privacyVersion === CURRENT_LEGAL_ACCEPTANCE.privacyVersion) {
    return { termsVersion: input.termsVersion, privacyVersion: input.privacyVersion, sawUsageDataNotice: true };
  }
  if (input.privacyVersion === PREVIOUS_PRIVACY_VERSION && now < previousPrivacyVersionAcceptedUntil) {
    return { termsVersion: input.termsVersion, privacyVersion: input.privacyVersion, sawUsageDataNotice: false };
  }
  throw new TermsChangedError();
}

/** Test-only: move the end of the previous-version grace window. */
export function setPreviousPrivacyVersionAcceptedUntilForTest(until: Date | null): void {
  previousPrivacyVersionAcceptedUntil = until ?? PREVIOUS_PRIVACY_VERSION_ACCEPTED_UNTIL;
}

export async function insertUserLegalAcceptance(
  tx: DatabaseExecutor,
  userId: string,
  source: LegalAcceptanceSource,
  metadata: LegalAcceptanceMetadata = {},
  accepted: Pick<AcceptedLegalVersions, "termsVersion" | "privacyVersion"> = CURRENT_LEGAL_ACCEPTANCE,
) {
  await tx.insert(userLegalAcceptances).values({
    userId,
    // The versions this person actually agreed to, not merely the current ones.
    termsVersion: accepted.termsVersion,
    privacyVersion: accepted.privacyVersion,
    termsUrl: CURRENT_LEGAL_ACCEPTANCE.termsUrl,
    privacyUrl: CURRENT_LEGAL_ACCEPTANCE.privacyUrl,
    source,
    ipHash: hashEvidence(metadata.ipAddress),
    userAgentHash: hashEvidence(metadata.userAgent),
    locale: metadata.locale ?? null,
  });
}

export function legalAcceptanceErrorResponse(err: unknown) {
  if (err instanceof LegalAcceptanceRequiredError) {
    return {
      status: 422,
      body: {
        error: "LEGAL_ACCEPTANCE_REQUIRED",
        legal: CURRENT_LEGAL_ACCEPTANCE,
      },
    };
  }
  if (err instanceof TermsChangedError) {
    return {
      status: 409,
      body: {
        error: "TERMS_CHANGED",
        legal: CURRENT_LEGAL_ACCEPTANCE,
      },
    };
  }
  return null;
}

export function currentLegalAcceptanceResponse() {
  return CURRENT_LEGAL_ACCEPTANCE;
}

export function getRequestLegalMetadata(req: { ip?: string; get: (name: string) => string | undefined }): LegalAcceptanceMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    locale: req.get("accept-language") ?? null,
  };
}
