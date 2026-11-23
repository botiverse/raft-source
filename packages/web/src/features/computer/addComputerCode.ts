// Add Computer's "the terminal shows a code" path: approving a
// `raft-computer setup` run on another computer from the Add Computer window,
// the same describe/approve as the device login page
// (components/auth/useDeviceLoginApproval.ts), with the server fixed to the
// one the window was opened for.

import type { IntlShape } from "react-intl";
import { deviceLoginConfirmTitle } from "../../components/auth/deviceLoginApproval";
import type { AttachableServer, DeviceLoginRequest } from "../../components/auth/deviceLoginApproval";
import type { DeviceLoginStep } from "../../components/auth/useDeviceLoginApproval";

/** The device login page: where a code this window can't approve is approved. Never with the code in it. */
export const DEVICE_LOGIN_PATH = "/login/device";

/**
 * The window's server as describe offers it, when this code adds a computer
 * (computer_attach) or moves one's old daemon over (computer_migrate) and
 * the person may approve that for this server; else null (a sign-in, an agent
 * key, or a server it can't target here): the device login page instead.
 */
export function codeTargetServer(request: DeviceLoginRequest, serverId: string | null): AttachableServer | null {
  const { grant } = request;
  if (!serverId || !grant || (grant.kind !== "computer_attach" && grant.kind !== "computer_migrate")) return null;
  return grant.servers.find((server) => server.id === serverId) ?? null;
}

/** Errors the device login page can still help with (another server, a kind only it explains): offer it. */
export function codeErrorOffersDevicePage(errorCode: string | null): boolean {
  return errorCode === "grant_kind_unsupported" || errorCode === "grant_selection_not_allowed" || errorCode === "grant_selection_required";
}

/** The window's title while a typed code takes it (null: it doesn't), as the device login page titles the same step. */
export function codeReviewTitle(formatMessage: IntlShape["formatMessage"], step: DeviceLoginStep, serverId: string | null): string | null {
  if (step.kind === "stepUp") return formatMessage({ id: "pages.deviceLogin.approveTitle" });
  if (step.kind !== "confirm") return null;
  return codeTargetServer(step.request, serverId)
    ? deviceLoginConfirmTitle(formatMessage, step.request.grant)
    : formatMessage({ id: "pages.deviceLogin.approveTitle" });
}
