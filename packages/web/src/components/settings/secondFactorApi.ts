/**
 * The web's calls to /api/auth/second-factor (packages/server/src/routes/
 * secondFactor.ts): a person managing their own two-step verification.
 * The sign-in's own second step (unauthenticated) is in
 * components/auth/secondFactorSignIn.ts.
 */
import api from "../../api/client";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import { parseMethods } from "../auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import type {
  PasskeyAssertionJSON,
  PasskeyCreationOptionsJSON,
  PasskeyRegistrationJSON,
  PasskeyRequestOptionsJSON,
} from "../auth/webauthn";

export interface SecondFactorStatus {
  enabled: boolean;
  methods: { totp: boolean; passkeys: number; backupCodesRemaining: number };
  /** This sign-in passed the second step (at sign-in or by POST /step-up); absent from older servers. */
  sessionVerified?: boolean;
}

/** How many backup codes a fresh set has (server backupCodes.ts). */
export const BACKUP_CODE_SET_SIZE = 10;

/** From this many left and below, the section asks to regenerate (design A13). */
export const LOW_BACKUP_CODES = 3;

/**
 * A step-up answer: a current authenticator code, a backup code (where
 * allowed), or a passkey assertion from startStepUpPasskeyAssertion.
 */
export type StepUpAnswer = { code: string } | { backupCode: string } | { webauthn: PasskeyAssertionJSON };

const BASE = "/auth/second-factor";

export async function fetchSecondFactorStatus(): Promise<SecondFactorStatus> {
  const { data } = await api.get<SecondFactorStatus>(`${BASE}/status`);
  return data;
}

/** Off: needs a recent sign-in or POST /reauth/password first (403 reauth_required). */
export async function startTotpSetup(): Promise<{ secret: string; otpauthUri: string }> {
  const { data } = await api.post<{ secret: string; otpauthUri: string }>(`${BASE}/totp/setup`, {});
  return data;
}

/**
 * Turns two-step verification on: a code from the app set up by /totp/setup
 * (or already confirmed) confirms it, or a passkey already registered answers
 * instead (design A9: no authenticator app needed; an assertion from
 * startStepUpPasskeyAssertion). Returns the backup codes, once.
 */
export async function enableSecondFactor(answer: { code: string } | { webauthn: PasskeyAssertionJSON }): Promise<string[]> {
  const { data } = await api.post<{ backupCodes: string[] }>(`${BASE}/enable`, answer);
  return data.backupCodes;
}

export async function disableSecondFactor(answer: StepUpAnswer): Promise<void> {
  await api.post(`${BASE}/disable`, answer);
}

/** Step-up with an authenticator code or a passkey (the server refuses a backup code here). */
export async function regenerateBackupCodes(answer: { code: string } | { webauthn: PasskeyAssertionJSON }): Promise<string[]> {
  const { data } = await api.post<{ backupCodes: string[] }>(`${BASE}/backup-codes/regenerate`, answer);
  return data.backupCodes;
}

/**
 * Marks this sign-in as having passed the second step (an authenticator code,
 * a backup code or a passkey), so it can approve device and app logins. Asked
 * for up front when the status says this sign-in isn't verified
 * (stepUpBeforeApproval), or when an approval answers 403
 * `second_factor_step_up_required`. Sensitive actions (password, sign-in
 * methods, agent keys) ask for it the same way: secondFactorStepUp.ts.
 */
export async function stepUpThisSignIn(answer: StepUpAnswer): Promise<void> {
  await api.post(`${BASE}/step-up`, answer);
}

/**
 * Before approving a device or app login: the methods to step up with when two-step
 * verification is on and this sign-in hasn't passed it, otherwise null (also when
 * the status can't be read: the approval
 * then goes as before, with its 403 as the fallback).
 */
export async function stepUpBeforeApproval(): Promise<SignInSecondFactorMethod[] | null> {
  let status: SecondFactorStatus;
  try {
    status = await fetchSecondFactorStatus();
  } catch {
    return null;
  }
  if (status?.enabled !== true || status.sessionVerified !== false) return null;
  const { methods } = status;
  return [
    ...(methods?.totp ? ["totp" as const] : []),
    ...((methods?.passkeys ?? 0) > 0 ? ["passkey" as const] : []),
    ...((methods?.backupCodesRemaining ?? 0) > 0 ? ["backup_code" as const] : []),
  ];
}

/** POST /passkeys/assertion/options {}: a passkey assertion bound to this sign-in, to answer step-up (or /enable) with. */
export async function startStepUpPasskeyAssertion(): Promise<PasskeyRequestOptionsJSON> {
  const { data } = await api.post<{ options: PasskeyRequestOptionsJSON }>(`${BASE}/passkeys/assertion/options`, {});
  return data.options;
}

// ── Passkeys (Settings › Account › Passkeys) ──

export interface PasskeySummary {
  id: string;
  /** The person's label, or the provider's name from the AAGUID ("iCloud Keychain"), or "Passkey". */
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Backed up by its provider (backup_state): shown as Synced. */
  synced: boolean;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const { data } = await api.get<{ passkeys: PasskeySummary[] }>(`${BASE}/passkeys`);
  return data.passkeys;
}

/**
 * Starts adding a passkey. With two-step verification off it needs a recent
 * sign-in or POST /reauth/password (403 `reauth_required`); with it on, a
 * step-up answer in the same request (403 `step_up_required` with `methods`).
 */
export async function startPasskeyRegistration(answer?: StepUpAnswer): Promise<PasskeyCreationOptionsJSON> {
  const { data } = await api.post<{ options: PasskeyCreationOptionsJSON }>(`${BASE}/passkeys/registration/options`, answer ?? {});
  return data.options;
}

export async function finishPasskeyRegistration(response: PasskeyRegistrationJSON): Promise<PasskeySummary> {
  const { data } = await api.post<{ passkey: PasskeySummary }>(`${BASE}/passkeys/registration/verify`, { response });
  return data.passkey;
}

export async function renamePasskey(id: string, name: string): Promise<PasskeySummary> {
  const { data } = await api.patch<{ passkey: PasskeySummary }>(`${BASE}/passkeys/${encodeURIComponent(id)}`, { name });
  return data.passkey;
}

/**
 * With two-step verification on it needs a step-up answer (403
 * `step_up_required` with `methods` without one), and never takes the last
 * factor (409 `last_factor`).
 */
export async function removePasskey(id: string, answer?: StepUpAnswer): Promise<void> {
  await api.delete(`${BASE}/passkeys/${encodeURIComponent(id)}`, { data: answer ?? {} });
}

/** 204: this sign-in counts as re-authenticated for 10 minutes. */
export async function reauthenticateWithPassword(password: string): Promise<void> {
  await api.post(`${BASE}/reauth/password`, { password });
}

export interface SecondFactorFailure {
  status?: number;
  code?: string;
  /** ISO time, on `second_factor_locked` and `reauth_locked`. */
  lockedUntil?: string;
  /** On `step_up_required`: what the person can answer with. */
  methods: SignInSecondFactorMethod[];
}

export function secondFactorFailureOf(err: unknown): SecondFactorFailure {
  const response = getApiErrorResponse(err);
  const data = (err as { response?: { data?: { lockedUntil?: unknown; methods?: unknown } } } | null)?.response?.data;
  return {
    status: response?.status,
    code: response?.code,
    lockedUntil: typeof data?.lockedUntil === "string" ? data.lockedUntil : undefined,
    methods: parseMethods(data?.methods),
  };
}

/** What the person typed, as the server takes it: no spaces (a code may be pasted as "123 456"). */
export function normalizeEnteredCode(value: string): string {
  return value.replace(/\s+/g, "");
}
