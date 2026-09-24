import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../db/index.js";
import { userLegalAcceptances } from "../db/schema.js";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";

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

export function requireCurrentLegalAcceptance(input: LegalAcceptanceInput | undefined) {
  if (!input?.acceptTerms) {
    throw new LegalAcceptanceRequiredError();
  }
  if (
    input.termsVersion !== CURRENT_LEGAL_ACCEPTANCE.termsVersion
    || input.privacyVersion !== CURRENT_LEGAL_ACCEPTANCE.privacyVersion
  ) {
    throw new TermsChangedError();
  }
}

export async function insertUserLegalAcceptance(
  tx: DatabaseExecutor,
  userId: string,
  source: LegalAcceptanceSource,
  metadata: LegalAcceptanceMetadata = {},
) {
  await tx.insert(userLegalAcceptances).values({
    userId,
    termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
    privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
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
