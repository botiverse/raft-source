/**
 * Authenticator-app codes (TOTP, RFC 6238 over RFC 4226 HOTP): HMAC-SHA-1,
 * 30-second steps, 6 digits, a code accepted one step either side of now
 * (design §5). A code is refused when its step is not above the last step
 * accepted for the person (`user_totp.last_used_step`): the replay guard.
 *
 * Pure crypto plus one conditional write (recordTotpStep). Used by the
 * management routes (management.ts) and sign-in's second step (signIn.ts). The secret is
 * stored only encrypted (totpSecretCrypto.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import type { DatabaseExecutor } from "../../db/index";
import { userTotp } from "../../db/schema";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now a code is still accepted for (clock drift). */
export const TOTP_WINDOW_STEPS = 1;
/** 160 bits, the RFC 4226 recommended secret length for HMAC-SHA-1. */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding: the form authenticator apps take a secret in. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode RFC 4648 base32 (case-insensitive, padding and spaces ignored); null when malformed. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random secret, base32 (what the QR code and manual entry show). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * The `otpauth://totp/...` URI an authenticator app scans
 * (Key Uri Format: issuer in both the label and the parameter).
 */
export function totpUri(input: { secret: string; accountName: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The 30-second step `now` falls in. */
export function totpStepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP value for one counter (the TOTP step), zero-padded to `digits`. */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24)
    | (mac[offset + 1]! << 16)
    | (mac[offset + 2]! << 8)
    | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: "malformed" | "invalid" | "replayed" };

/**
 * Check `code` against the secret at `now` (±1 step). On a match returns the
 * matched step, which the caller then records with recordTotpStep (the
 * race-safe half of the replay guard). A code whose step is not above
 * `lastUsedStep` is refused as replayed.
 */
export function verifyTotp(input: {
  secret: string;
  code: string;
  now?: Date;
  lastUsedStep?: number | null;
  digits?: number;
}): TotpVerifyResult {
  const digits = input.digits ?? TOTP_DIGITS;
  const code = input.code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return { ok: false, reason: "malformed" };
  const key = base32Decode(input.secret);
  if (!key || key.length === 0) return { ok: false, reason: "malformed" };
  const current = totpStepAt(input.now ?? currentDate());
  let matched: number | null = null;
  // Check every candidate step (no early exit) so timing does not say which matched.
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, digits));
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (input.lastUsedStep !== null && input.lastUsedStep !== undefined && matched <= input.lastUsedStep) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, step: matched };
}

/**
 * Record an accepted step: only when it is above the stored one, so of two
 * concurrent uses of the same code exactly one wins. False = replayed (or no
 * TOTP row for the person, or the verified secret has been replaced).
 */
export async function recordTotpStep(executor: DatabaseExecutor, userId: string, step: number, verifiedCiphertext: string): Promise<boolean> {
  const updated = await executor
    .update(userTotp)
    .set({ lastUsedStep: step })
    .where(and(
      eq(userTotp.userId, userId),
      eq(userTotp.secretCiphertext, verifiedCiphertext),
      or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step)),
    ))
    .returning({ userId: userTotp.userId });
  return updated.length === 1;
}
