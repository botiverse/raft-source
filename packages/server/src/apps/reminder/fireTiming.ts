export interface ReminderCatchupTiming {
  dueAtMs: number;
  firedAtClient: string;
  serverObservedAtMs: number;
  toleranceMs: number;
}

/**
 * Classify whether the Computer missed the due slot, independently of
 * transport latency between the local timer and the Server handler.
 *
 * The Server remains the authority for whether the reminder is due. This
 * helper only classifies the accepted occurrence for user-facing diagnostics.
 * A malformed client observation falls back to the Server receipt time.
 */
export function isReminderCatchup(input: ReminderCatchupTiming): boolean {
  const firedAtClientMs = Date.parse(input.firedAtClient);
  const observedAtMs = Number.isNaN(firedAtClientMs)
    ? input.serverObservedAtMs
    : firedAtClientMs;
  return input.dueAtMs + input.toleranceMs < observedAtMs;
}
