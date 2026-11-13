/**
 * The second step of a sign-in (#triage:#135, design v2 group b). Only for
 * people who turned two-step verification on: the server decides, so a sign-in whose answer has no
 * `secondFactorRequired` goes on exactly as before and nothing here runs.
 *
 * Server (routes/auth.ts, services/secondFactor/signIn.ts):
 *   - POST /auth/login, /auth/:provider/complete and /auth/mobile/oauth/complete
 *     answer `{ secondFactorRequired: true, challenge, expiresAt, methods,
 *     maskedEmail }` instead of tokens: a 5-minute, single-use challenge.
 *   - POST /auth/second-factor/passkeys/assertion/options { challenge } answers
 *     `{ options }`: a passkey assertion bound to that sign-in.
 *   - POST /auth/second-factor/verify { challenge, code | backupCode |
 *     webauthn | recovery: true, codeVerifier? (the desktop loopback's PKCE verifier) } answers with the
 *     same body the first step would have given without it (plus
 *     `backupCodesRemaining` after a backup code), or `{ code }`:
 *     second_factor_code_invalid / backup_code_used (400), challenge_expired
 *     (410), challenge_attempts_exhausted / second_factor_locked with
 *     `lockedUntil` (429), second_factor_unavailable (503).
 *
 * A pending second step lives in memory only (useSecondFactorSignIn): a
 * reload starts the sign-in again, as an expired challenge would.
 */
import { create } from "zustand";

import api from "../../api/client";
import { canUsePasskeys } from "./webauthn";
import type { PasskeyAssertionJSON, PasskeyRequestOptionsJSON } from "./webauthn";

/** The server's opaque sign-in challenge (auth_challenges); only parseSecondFactorChallenge makes one. */
export type SecondFactorChallengeToken = string & { readonly __secondFactorChallengeToken: unique symbol };

/** A second factor the server lists for the person: only what they set up. */
export type SignInSecondFactorMethod = "totp" | "passkey" | "backup_code";

/** The methods answered by typing a code. */
export type CodeMethod = "totp" | "backup_code";

export interface SecondFactorChallenge {
  challenge: SecondFactorChallengeToken;
  /** ISO time the challenge stops working. */
  expiresAt: string;
  methods: SignInSecondFactorMethod[];
  /**
   * The challenge also lists `recovery`: the person's email reset is past its
   * 72-hour wait, so `{ recovery: true }` can answer this step
   * (secondFactorRecovery.ts).
   */
  recoveryReady: boolean;
  /** `a***@example.com`. */
  maskedEmail: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const METHODS: ReadonlySet<string> = new Set<SignInSecondFactorMethod>(["totp", "passkey", "backup_code"]);

/** A first step's answer that asks for the second step; null for any other answer (signed in as before). */
export function parseSecondFactorChallenge(data: unknown): SecondFactorChallenge | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (body.secondFactorRequired !== true) return null;
  if (typeof body.challenge !== "string" || !TOKEN_RE.test(body.challenge)) return null;
  if (typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) return null;
  if (typeof body.maskedEmail !== "string") return null;
  const methods = parseMethods(body.methods);
  const recoveryReady = Array.isArray(body.methods) && body.methods.includes("recovery");
  return { challenge: body.challenge as SecondFactorChallengeToken, expiresAt: body.expiresAt, methods, recoveryReady, maskedEmail: body.maskedEmail };
}

/** A first step's answer that asks for the second step in a shape this page can't read (#triage:#165). */
export class SecondFactorChallengeUnreadableError extends Error {
  override name = "SecondFactorChallengeUnreadable";
}

/** parseSecondFactorChallenge for a password sign-in: an unreadable second step throws instead of reading as signed in. */
export function readSecondFactorChallenge(data: unknown): SecondFactorChallenge | null {
  const challenge = parseSecondFactorChallenge(data);
  if (!challenge && (data as { secondFactorRequired?: unknown } | null)?.secondFactorRequired === true) {
    throw new SecondFactorChallengeUnreadableError("The second step's challenge can't be read");
  }
  return challenge;
}

/** The `methods` of a challenge, a lock or a step-up refusal; unknown entries dropped. */
export function parseMethods(value: unknown): SignInSecondFactorMethod[] {
  return Array.isArray(value)
    ? value.filter((method): method is SignInSecondFactorMethod => typeof method === "string" && METHODS.has(method))
    : [];
}

/** Fallback order when this device used none of them yet (D4): passkey, authenticator code, backup code. */
const METHOD_ORDER = ["passkey", "totp", "backup_code"] as const;

/**
 * The listed methods this browser can answer with, in the design's order
 * (D4); `passkeyUnsupported`: a passkey is listed but this browser (or Raft
 * Desktop) can't use one (design step-passkey-unsupported).
 */
export function usableMethodsOf(methods: readonly SignInSecondFactorMethod[]): {
  methods: SignInSecondFactorMethod[];
  passkeyUnsupported: boolean;
} {
  const passkeys = canUsePasskeys();
  return {
    methods: METHOD_ORDER.filter((method) => methods.includes(method) && (method !== "passkey" || passkeys)),
    passkeyUnsupported: methods.includes("passkey") && !passkeys,
  };
}

/** `recovery: true` finishes the person's ready email reset instead of a factor (secondFactorRecovery.ts). */
export type SecondFactorSignInAnswer =
  | { code: string }
  | { backupCode: string }
  | { webauthn: PasskeyAssertionJSON }
  | { recovery: true };

/** POST /auth/second-factor/passkeys/assertion/options { challenge }: a passkey assertion for this sign-in. */
export async function startSignInPasskeyStep(challenge: SecondFactorChallengeToken): Promise<PasskeyRequestOptionsJSON> {
  const { data } = await api.post<{ options: PasskeyRequestOptionsJSON }>("/auth/second-factor/passkeys/assertion/options", { challenge });
  return data.options;
}

/** POST /auth/second-factor/verify: resolves the first step's success body. */
export async function verifySecondFactorSignIn(
  challenge: SecondFactorChallengeToken,
  answer: SecondFactorSignInAnswer,
  codeVerifier?: string,
): Promise<unknown> {
  const { data } = await api.post<unknown>("/auth/second-factor/verify", {
    challenge,
    ...answer,
    ...(codeVerifier ? { codeVerifier } : {}),
  });
  return data;
}

// ── D4: start with the method this device used last ──

const LAST_METHOD_KEY = "raft.second-factor.last-method";

/** Which method this device used last (no account, only the method). */
export function rememberSecondFactorMethod(method: SignInSecondFactorMethod): void {
  try {
    localStorage.setItem(LAST_METHOD_KEY, method);
  } catch {
    // Storage off: the next sign-in starts with the default order.
  }
}

/** The method to show first: the last one used here if listed, else the first listed. */
export function initialMethod(methods: readonly SignInSecondFactorMethod[]): SignInSecondFactorMethod | null {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_METHOD_KEY);
  } catch {
    last = null;
  }
  const remembered = methods.find((method) => method === last);
  return remembered ?? methods[0] ?? null;
}

// ── The pending second step of a password or desktop sign-in ──

export interface PendingSecondFactorSignIn {
  challenge: SecondFactorChallenge;
  /** The email the person typed at the first step (a password sign-in), to fill the reset request with. */
  email?: string;
  /** The desktop loopback's PKCE verifier, sent back with the answer. */
  codeVerifier?: string;
  /** Applies the verify answer (the first step's success body): the session, as the first step would have. */
  finish: (body: unknown) => Promise<void>;
}

/**
 * The second step a password sign-in (authStore.login) or a Raft Desktop
 * social sign-in (desktopOAuth.ts) is waiting on; the signed-out screens show
 * it in place of sign-in while it is set. A web social sign-in keeps its own
 * on the callback page (SocialAuthCallbackPage).
 */
export const useSecondFactorSignIn = create<{ pending: PendingSecondFactorSignIn | null }>(() => ({ pending: null }));

export function startSecondFactorSignIn(pending: PendingSecondFactorSignIn): void {
  useSecondFactorSignIn.setState({ pending });
}

export function clearSecondFactorSignIn(): void {
  useSecondFactorSignIn.setState({ pending: null });
}

/** Run `next` after the pending step's own finish (an account-link sign-in's landing). */
export function afterSecondFactorSignIn(next: () => void): void {
  const current = useSecondFactorSignIn.getState().pending;
  if (!current) return;
  useSecondFactorSignIn.setState({
    pending: {
      ...current,
      finish: async (body) => {
        await current.finish(body);
        next();
      },
    },
  });
}
