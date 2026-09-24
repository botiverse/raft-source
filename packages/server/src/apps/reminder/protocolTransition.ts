import {
  REMINDER_FIRE_RECEIPT_CAPABILITY,
  REMINDER_FIRE_REQUEST_CAPABILITY,
} from "@botiverse/raft-shared/src/apps/reminder/protocol.js";

export interface ReminderProtocolConnectionFacts {
  daemonVersion: string | null;
  capabilities: ReadonlySet<string>;
}

export type ReminderDueProtocol = "legacy_fire_attempt" | "fire_receipt" | "fire_request" | "unknown";

const FIRST_FIRE_RECEIPT_DAEMON_VERSION = [1, 0, 16] as const;

function parseSemverTriple(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBeforeFireReceipt(version: readonly number[]): boolean {
  for (let index = 0; index < FIRST_FIRE_RECEIPT_DAEMON_VERSION.length; index += 1) {
    const currentPart = version[index] ?? 0;
    const receiptPart = FIRST_FIRE_RECEIPT_DAEMON_VERSION[index] ?? 0;
    if (currentPart < receiptPart) return true;
    if (currentPart > receiptPart) return false;
  }
  return false;
}

/**
 * Route Reminder due frames during the mixed-version transition. Daemon 1.0.14
 * and 1.0.15 send `reminder.fire_attempt` and reach the legacy bridge through
 * the handshake's `daemonVersion` fallback. Daemon >=1.0.16 never reaches that
 * legacy branch: an explicit ready capability selects `fire_request` first or
 * `fire_receipt` second, and the version fallback otherwise selects receipt.
 * `computerVersion` is deliberately not a decision fact because Computer and
 * daemon update independently and the daemon owns this wire.
 */
export function selectReminderDueProtocol(
  input: ReminderProtocolConnectionFacts,
): ReminderDueProtocol {
  if (input.capabilities.has(REMINDER_FIRE_REQUEST_CAPABILITY)) return "fire_request";
  if (input.capabilities.has(REMINDER_FIRE_RECEIPT_CAPABILITY)) return "fire_receipt";
  const daemonVersion = parseSemverTriple(input.daemonVersion);
  if (!daemonVersion) return "unknown";
  return isBeforeFireReceipt(daemonVersion) ? "legacy_fire_attempt" : "fire_receipt";
}
