import type { IntlShape } from "react-intl";
import { useMachineStore } from "../store/machineStore";

/** The server refused because the agent's Computer is offline (409 `machine_offline`, e.g. POST /agents/:id/start). */
export function isMachineOfflineError(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  return response?.data?.code === "machine_offline";
}

/**
 * A Start the server refused with `machine_offline` (#triage:#206): mark that
 * Computer offline in the machine store until its next status update, so the
 * status chip, the profile's Info and offline card, and Start all agree even
 * when this tab missed the offline push. Returns the error to rethrow.
 */
export function noteMachineOfflineRefusal(error: unknown, machineId: string | null | undefined): unknown {
  if (machineId && isMachineOfflineError(error)) useMachineStore.getState().markMachineOfflineFromRefusal(machineId);
  return error;
}

/** What to say about a Start the server refused for another reason: its own words, else the generic failure. */
export function startRefusalText(error: unknown, formatMessage: IntlShape["formatMessage"]): string {
  const said = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof said === "string" && said ? said : formatMessage({ id: "agent.detail.startAgentFailed" });
}
