import type { Machine, MachineUpgradeRequest } from "../store/machineStore";

/** Server deadline for an upgrade request (UPGRADE_REQUEST_DEADLINE_MS in
 *  computerUpgradeRequestService); past it the server settles the request as
 *  no_response, so the client copy cannot outlive it either. Only the
 *  fallback for an older server whose request carries no `deadlineAt`. */
export const COMPUTER_UPGRADE_REQUEST_DEADLINE_MS = 30 * 60 * 1000;

/** The request the server accepted for a web Upgrade click, kept by this tab.
 *  `acceptedAtMs` is the client clock, so the deadline is not skewed by the
 *  server's. */
export interface AcceptedComputerUpgrade {
  request: MachineUpgradeRequest;
  acceptedAtMs: number;
}

/**
 * How long the server waits for this request before settling it as
 * no_response: its own `deadlineAt - requestedAt` (both server clock, so no
 * skew; a request whose Computer waits for its agents first is longer,
 * reconciler step 13), else COMPUTER_UPGRADE_REQUEST_DEADLINE_MS.
 */
export function computerUpgradeRequestDeadlineMs(request: Pick<MachineUpgradeRequest, "requestedAt" | "deadlineAt">): number {
  if (!request.deadlineAt) return COMPUTER_UPGRADE_REQUEST_DEADLINE_MS;
  const ms = Date.parse(request.deadlineAt) - Date.parse(request.requestedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : COMPUTER_UPGRADE_REQUEST_DEADLINE_MS;
}

/**
 * The upgrade request in flight for a machine, or null.
 *
 * The server's pending row is the answer when the row carries one. Otherwise
 * the request this tab saw accepted stays in flight until there is evidence it
 * ended: the server row shows that request (or a later one) settled, the
 * machine is online at the target version, or the request's deadline passed.
 * A refresh that lands without the pending row (a coalesced read, a reconnect
 * window) is not such evidence, so the page keeps saying "upgrading" instead
 * of dropping to the offline card mid-restart.
 */
export function computerUpgradeInFlight(
  machine: Pick<Machine, "status" | "computerVersion" | "upgradeRequest">,
  accepted: AcceptedComputerUpgrade | null,
  nowMs: number,
): MachineUpgradeRequest | null {
  const row = machine.upgradeRequest ?? null;
  if (row?.state === "pending") return row;
  if (!accepted) return null;
  if (row && (row.id === accepted.request.id || Date.parse(row.requestedAt) >= Date.parse(accepted.request.requestedAt))) {
    return null;
  }
  if (machine.status === "online" && machine.computerVersion === accepted.request.targetVersion) return null;
  if (nowMs >= accepted.acceptedAtMs + computerUpgradeRequestDeadlineMs(accepted.request)) return null;
  return accepted.request;
}
