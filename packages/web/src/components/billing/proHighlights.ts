import {
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  PLAN_CONFIG,
  PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
} from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/**
 * What Pro adds over Free, in this order, wherever Raft lists it: this dialog, the
 * onboarding Pro step and Plan & billing's Upgrade card (cindyz, #proj-commercial:#28).
 * `note` says what the item is where its name alone doesn't: Plan & billing shows it as an
 * info icon's tooltip; the upgrade dialog doesn't show it (cindyz, #proj-commercial:ba39bee1).
 */
export const PRO_HIGHLIGHTS = [
  { key: "history", pro: "layout.onboarding.proUnlimitedMessageHistory", free: "layout.onboarding.freeMessageHistory" },
  { key: "files", pro: "layout.onboarding.proFileUploads", free: "layout.onboarding.freeFileUploads" },
  { key: "joint", pro: "layout.onboarding.proUnlimitedJointChannels", free: "layout.onboarding.freeJointChannelHosts", note: "layout.onboarding.proExternalChannelsNote" },
  { key: "migration", pro: "layout.onboarding.proAgentMigration", free: "layout.onboarding.freeNotIncluded" },
] as const satisfies ReadonlyArray<{ key: string; pro: MessageId; free: MessageId; note?: MessageId }>;

export type ProHighlightKey = (typeof PRO_HIGHLIGHTS)[number]["key"];

/** Keep a limit's number and MB unit together in every locale and viewport. */
function formatMegabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}

/** The values PRO_HIGHLIGHTS' messages take. */
export const HIGHLIGHT_VALUES = {
  historyDays: PLAN_CONFIG.free.limits.messageHistoryDays,
  freeMonthlyFileLimit: formatMegabytes(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES),
  freeSingleFileLimit: formatMegabytes(FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES),
  proSingleFileLimit: formatMegabytes(PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES),
};
