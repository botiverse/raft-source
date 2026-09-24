import api from "../api/client";
import { registerServerReset } from "../store/serverResetRegistry";

/**
 * The single-file upload ceiling is server-owned.
 *
 * `packages/server/.env.example` states the contract plainly: the threshold is
 * server-owned and returned to Web/CLI; clients must not copy it. The server's
 * effective ceiling is `min(plan limit, 90 MiB transport safety margin)` while
 * direct upload is off, and the plan limit once it is on. When direct upload is
 * on, its advertised threshold is capped at that same legacy ceiling so every
 * file below the threshold remains valid on the fallback transport
 * (`getEffectiveAttachmentDirectUploadThresholdBytes` /
 * `getLegacyAttachmentFileSizeLimitBytes` / `getAttachmentFileSizeLimitBytes`).
 * A client that re-derives any part of that
 * drifts the moment either input moves — which is exactly how a Pro-plan
 * composer came to accept a file the server then refused, leaving the user with
 * a bare "Upload failed".
 *
 * So this module never computes a limit. It reports what the server said, or
 * reports that it does not know. There is deliberately no plan-derived
 * fallback, not even as a last resort: a locally invented ceiling is either too
 * high (silently accepts files the server rejects — the defect this replaces)
 * or too low (rejects files the plan paid for). An unknown ceiling blocks the
 * attachment instead, so the failure is visible and honest rather than a
 * fallback that is quietly wider than the real rule.
 */

/** The one field the composer needs; the capability body carries more. */
interface UploadCapabilityResponse {
  maxBytes: number;
}

export interface AttachmentUploadLimitSource {
  get<T>(path: string): Promise<{ data: T }>;
}

/**
 * Deliberately no cache of the resolved value.
 *
 * A cached ceiling must be invalidated on everything that can move it, and that
 * set is not closeable from the client. The plan can change on the same server
 * — `server:plan-updated` reaches `applyServerPatch`, which patches the store
 * without going through the reset registry — and the direct-upload threshold
 * can change server-side on a deploy with no client-visible event at all.
 * Enumerating invalidation triggers would leave the composer validating against
 * a stale server value: the same defect as computing the limit locally, only
 * sourced differently and harder to see, because whether it bites depends on
 * how long the tab has been open.
 *
 * So the ceiling is fetched per selection. Picking files is an occasional,
 * user-initiated action that already awaits this value before attaching, so the
 * cost is one small request at the moment it is about to matter.
 */
let inFlight: Promise<number | null> | null = null;

// One selection can ask more than once (multi-file, rapid re-pick); those share
// a single request. The window is milliseconds, so this coalesces requests
// rather than caching the value.
registerServerReset(() => {
  inFlight = null;
});

/**
 * Resolve the server's effective single-file ceiling in bytes, or `null` when
 * it cannot be established. `null` means "do not allow the upload" — never
 * "substitute a local guess".
 */
export async function resolveAttachmentUploadLimitBytes(
  source: AttachmentUploadLimitSource = api,
): Promise<number | null> {
  inFlight ??= fetchLimitBytes(source).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchLimitBytes(source: AttachmentUploadLimitSource): Promise<number | null> {
  try {
    const { data } = await source.get<UploadCapabilityResponse>("/attachments/upload-capabilities");
    // A non-positive or non-finite ceiling is not a usable rule; treat it as
    // unknown rather than letting it read as "everything is too large".
    if (!Number.isFinite(data?.maxBytes) || data.maxBytes <= 0) return null;
    return data.maxBytes;
  } catch {
    return null;
  }
}

export function resetAttachmentUploadLimitForTests(): void {
  inFlight = null;
}
