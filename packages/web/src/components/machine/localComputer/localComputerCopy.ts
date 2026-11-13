// The words for a local Computer operation that failed (useLocalComputerHost.ts).
// Two surfaces, two vocabularies, as before the move from the desktop: the
// Computers list and detail panel name the cause; onboarding speaks about
// adding this computer. Never a command: the raw error is only under
// Technical details.
import type { IntlShape } from "react-intl";
import type { HostErrorCode } from "./localComputerLogic";

function errorOf(error: unknown): { code: HostErrorCode | string; detail: string | null } {
  const code = (error as { code?: unknown } | null)?.code;
  const detail = (error as { detail?: unknown } | null)?.detail;
  return { code: typeof code === "string" ? code : "unknown", detail: typeof detail === "string" && detail ? detail : null };
}

/** The codes both surfaces say the same way (null: the surface's own words). */
function sharedMessage(code: string, detail: string | null, { formatMessage }: IntlShape): string | null {
  switch (code) {
    case "install_failed": return formatMessage({ id: "computerHost.errorInstallFailed" });
    case "install_held": return detail
      ? formatMessage({ id: "computerHost.errorInstallHeld" }, { reason: detail })
      : formatMessage({ id: "computerHost.errorInstallHeldNoReason" });
    case "install_download_failed": return formatMessage({ id: "computerHost.errorInstallDownload" });
    case "install_unsupported": return formatMessage({ id: "computerHost.errorInstallUnsupported" });
    case "too_old": return formatMessage({ id: "computerHost.errorTooOld" });
    case "update_unavailable": return formatMessage({ id: "computerHost.errorUpdateUnavailable" });
    case "install_still_finishing": return formatMessage({ id: "computerHost.errorInstallStillFinishing" });
    case "unreadable": return formatMessage({ id: "computerHost.errorUnreadable" });
    case "busy": return formatMessage({ id: "computerHost.errorBusy" });
    case "capability_missing": return formatMessage({ id: "computerHost.errorCapabilityMissing" });
    case "migration_failed": return formatMessage({ id: "computerHost.errorMigration" });
    case "cli_failed": return formatMessage({ id: "computerHost.errorCli" });
    case "server_unsupported": return formatMessage({ id: "computerHost.errorServerUnsupported" });
    // This machine is managed with buttons: never a command.
    case "duplicate_key": return formatMessage({ id: "computerHost.errorDuplicateKeyNoCommand" });
    default: return null;
  }
}

export function localComputerErrorMessage(error: unknown, intl: IntlShape): string {
  const { formatMessage } = intl;
  const { code, detail } = errorOf(error);
  const shared = sharedMessage(code, detail, intl);
  if (shared) return shared;
  switch (code) {
    case "not_signed_in": return formatMessage({ id: "computerHost.signIn" });
    case "admin_required": return formatMessage({ id: "computerHost.errorAdmin" });
    case "up_to_date": return formatMessage({ id: "computerHost.errorUpToDate" });
    case "service_unreachable": return formatMessage({ id: "computerHost.errorService" });
    case "host_unavailable": return formatMessage({ id: "computerHost.errorHost" });
    case "network": return formatMessage({ id: "computerHost.errorNetwork" });
    default: return formatMessage({ id: "computerHost.errorGeneric" });
  }
}

export function localComputerOnboardingErrorMessage(error: unknown, intl: IntlShape): string {
  const { formatMessage } = intl;
  const { code, detail } = errorOf(error);
  const shared = sharedMessage(code, detail, intl);
  if (shared) return shared;
  switch (code) {
    case "not_signed_in": return formatMessage({ id: "computerHost.onboarding.signIn" });
    case "admin_required": return formatMessage({ id: "computerHost.onboarding.errorAdmin" });
    case "host_unavailable": return formatMessage({ id: "computerHost.onboarding.errorHost" });
    case "network": return formatMessage({ id: "computerHost.onboarding.errorNetwork" });
    default: return formatMessage({ id: "computerHost.onboarding.errorGeneric" });
  }
}
