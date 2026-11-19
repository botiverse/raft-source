// A request that waits on a Computer past what the edge in front of the API
// allows (CloudFront: 30 s without bytes, #otter-lounge:#1): the client asks for
// `respondAsync`, gets 202 `{operationId}` once the request's own checks pass,
// and reads the answer the request would have had from
// GET /api/servers/:id/machine-operations/:operationId.
import type { JsonValue } from "./jsonValue";

/** One such request's handle; only the server mints it (a UUID). */
export type MachineOperationId = string & { readonly __machineOperationId: unique symbol };

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function asMachineOperationId(value: unknown): MachineOperationId | null {
  return typeof value === "string" && OPERATION_ID.test(value) ? value as MachineOperationId : null;
}

/** The body a request that asked for `respondAsync` with 202. */
export type MachineOperationStarted = { operationId: MachineOperationId };

/** What GET …/machine-operations/:operationId answers: still waiting, or the status and body the request would have answered. */
export type MachineOperationView =
  | { state: "pending" }
  | { state: "done"; status: number; body: JsonValue };

/** How often a client reads a pending operation. */
export const MACHINE_OPERATION_POLL_MS = 1_500;
