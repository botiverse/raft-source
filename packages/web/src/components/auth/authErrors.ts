import type { IntlShape } from "react-intl";

import type { MessageId } from "../../i18n/messages";

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Shared auth validation copy, as MESSAGE IDS.
 *
 * This was `AUTH_COPY`, a struct of five English sentences imported by four auth
 * pages. Every one of those pages could be migrated to react-intl, report zero
 * hardcoded-English findings, and still show English the moment a field failed
 * validation — the sentences lived one module away, so nothing at the call site
 * looked like copy.
 *
 * Typed as MessageId (not string) so an entry cannot quietly go back to being a
 * sentence: putting raw English here stops compiling.
 */
export const AUTH_MESSAGE_IDS = {
  invalidEmail: "auth.error.invalidEmail",
  passwordRequired: "auth.error.passwordRequired",
  passwordTooShort: "auth.error.passwordTooShort",
  passwordsDoNotMatch: "auth.error.passwordsDoNotMatch",
  incorrectCredentials: "auth.error.incorrectCredentials",
} as const satisfies Record<string, MessageId>;

export function isValidEmailFormat(email: string) {
  return EMAIL_FORMAT.test(email.trim());
}

type AuthErrorShape = {
  response?: { data?: { code?: unknown; error?: unknown } };
};

/**
 * Map a failed auth request to display text.
 *
 * Takes `formatMessage` rather than returning English, matching the shape
 * `formatNameValidationError` already established in this codebase.
 *
 * KNOWN RESIDUE, deliberately unchanged here: when the server sends its own
 * `error` string, that text is shown as-is and is currently English. Fixing it
 * means the server emitting codes instead of sentences — a server-side change
 * and a separate task. It is not papered over by dropping the server's message,
 * because that text is often the only actionable detail the user gets.
 */
export function authServerErrorMessage(
  error: unknown,
  fallback: string,
  formatMessage: IntlShape["formatMessage"],
): string {
  const data = (error as AuthErrorShape)?.response?.data;
  const code = data?.code;
  const message = data?.error;
  if (code === "AUTH_INVALID_CREDENTIALS" || message === "Invalid email or password") {
    return formatMessage({ id: AUTH_MESSAGE_IDS.incorrectCredentials });
  }
  return typeof message === "string" && message ? message : fallback;
}
