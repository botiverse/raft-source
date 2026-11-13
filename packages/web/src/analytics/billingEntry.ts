// Which paywall opened Plan & Billing (xxchan via Till, 2026-10-20): checkout
// and seat updates send it as `entry`, and the server records it with the
// purchase (billing_checkout_* / billing_seats_updated). A paywall's upgrade
// button calls noteBillingEntry() right before nav.toSettings("billing");
// Plan & Billing takes the note when it opens. Opened any other way, or too
// long after the note, the entry is `settings`.
import type { BillingEntry, PaywallGate } from "@botiverse/raft-shared";

const NOTE_TTL_MS = 10 * 60_000;

let note: { gate: PaywallGate; at: number } | null = null;

export function noteBillingEntry(gate: PaywallGate, now: number = Date.now()): void {
  note = { gate, at: now };
}

/** The entry for a Plan & Billing page opened now. Does not clear the note. */
export function peekBillingEntry(now: number = Date.now()): BillingEntry {
  return note && now - note.at <= NOTE_TTL_MS ? note.gate : "settings";
}

/** Plan & Billing took the note: the next opening starts from `settings`. */
export function clearBillingEntry(): void {
  note = null;
}
