import { isCredentialHoldReason, type CredentialHoldActivityDiagnostic } from "@botiverse/raft-shared";

/**
 * #proj-raft-computer:#48 (reconciler step 4b) — server-side normalizer for
 * the daemon's credential-hold carrier: the typed reason an idle frame showing
 * the held notice carries. The server passes it to the socket payload and the
 * activity read-back only, so anything but a known reason is dropped rather
 * than propagated (an older or newer daemon's unknown reason: the web shows
 * the plain status, as before the carrier).
 */
export function normalizeCredentialHoldActivityDiagnostic(
  value: CredentialHoldActivityDiagnostic | Record<string, unknown> | null | undefined,
): CredentialHoldActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = (value as Record<string, unknown>).reason;
  return isCredentialHoldReason(reason) ? { reason } : null;
}
