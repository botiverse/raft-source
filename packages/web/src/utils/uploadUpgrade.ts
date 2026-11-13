import type { PaywallSurface } from "@botiverse/raft-shared";
import { trackPaywallShown, trackUploadLimitHit } from "../analytics/paywall";
import type { UploadLimitEntry } from "../analytics/paywall";
import { monthlyUploadUsedUp } from "../store/monthlyUploadQuotaStore";
import { openUpgradeDialog } from "../store/upgradeDialogStore";
import type { UploadLimitContext } from "../store/upgradeDialogStore";
import type { AttachmentUpgradeGate } from "./attachmentLimitPresentation";

/**
 * Opens the upgrade dialog for an upload limit just hit (cindyz, 2026-10-28:
 * the dialog, not a notice). It opens by itself, so it is recorded as the
 * paywall shown, not as a click on Upgrade. `surface`: where it was met when
 * not an attachment upload (`artifact`: Save as Artifact), carried by the
 * dialog's actions and its checkout (#proj-commercial:#22).
 */
export function openUploadUpgrade(gate: AttachmentUpgradeGate, uploadContext?: UploadLimitContext, surface?: PaywallSurface): void {
  trackPaywallShown(gate, surface);
  openUpgradeDialog(gate, { unprompted: true, uploadContext, surface });
}

/**
 * True, having opened the upgrade dialog, when this month's uploads are used
 * up: every upload entry (attach, add image, drop, paste, Save as Artifact)
 * asks this first, so nobody picks a file that can't be uploaded.
 */
export function openUpgradeIfMonthUsedUp(entry: UploadLimitEntry, sizes: readonly number[] = []): boolean {
  const quota = monthlyUploadUsedUp();
  if (!quota) return false;
  trackUploadLimitHit({ limit: "monthly_quota", entry, response: "upgrade_dialog", sizes });
  openUploadUpgrade("upload_monthly_quota", { kind: "monthly_quota", quota, files: [] }, entry === "save_artifact" ? "artifact" : undefined);
  return true;
}
