// Why an unsupported runtime account has no usage reading (OAR's
// `AccountUsageUnsupportedReason`, #oar-raft:#30): the badge and the line the
// usage card shows for it (none where the badge says it).
import type { RuntimeAccountUsageUnsupportedReason } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages";

/**
 * The badge of an unsupported account, by OAR's reason: "no usage data" for an
 * account that reports no limits, "update required" for a CLI too old to
 * report them; any other reason, or none, keeps "unsupported".
 */
export function unsupportedReasonBadgeId(reason: RuntimeAccountUsageUnsupportedReason | undefined): MessageId | null {
  switch (reason) {
    case "quota_unavailable": return "machine.runtimeUsage.health.noUsageData";
    case "version_unsupported": return "machine.runtimeUsage.health.updateRequired";
    default: return null;
  }
}

/**
 * The line under an unsupported account saying why; none where its badge
 * already says it ("no usage data", "update required", "unsupported" for
 * `capability_unavailable` or no reason).
 */
export function unsupportedReasonTextId(reason: RuntimeAccountUsageUnsupportedReason | undefined): MessageId | null {
  switch (reason) {
    case "unsupported_auth_mode":
    case "unsupported_auth_storage":
    case "auth_configuration_unavailable":
    case "endpoint_unavailable":
    case "unsupported_installation":
      return `machine.runtimeUsage.unsupportedReason.${reason}`;
    case "quota_unavailable":
    case "version_unsupported":
    case "capability_unavailable":
    case undefined:
      return null;
  }
}
