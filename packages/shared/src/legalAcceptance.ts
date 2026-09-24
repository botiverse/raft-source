export const CURRENT_TERMS_VERSION = "2026-05-12";
export const CURRENT_PRIVACY_VERSION = "2026-05-12";
export const TERMS_URL = "https://raft.build/terms";
export const PRIVACY_URL = "https://raft.build/privacy";

export interface LegalAcceptanceVersions {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
}

export const CURRENT_LEGAL_ACCEPTANCE: LegalAcceptanceVersions = {
  termsVersion: CURRENT_TERMS_VERSION,
  privacyVersion: CURRENT_PRIVACY_VERSION,
  termsUrl: TERMS_URL,
  privacyUrl: PRIVACY_URL,
};
