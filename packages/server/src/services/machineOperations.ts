/**
 * Requests that wait on a Computer longer than the edge allows (#otter-lounge:#1).
 * CloudFront in front of the API closes a request whose origin sends nothing
 * for 30 s (60 s at most without an AWS quota), while a Claude limit-reset
 * read or redeem may wait up to RUNTIME_LIMIT_RESET_CLAUDE_RELAY_BUDGET_MS.
 *
 * A client that asks for it (`respondAsync: true`) gets 202 `{operationId}`
 * right after the request's own checks; the wait goes on here, and its answer
 * (the HTTP status and body the request would have had) is kept for
 * MACHINE_OPERATION_TTL_SECONDS, readable by the same person only
 * (GET …/machine-operations/:operationId). In Redis across replicas, per
 * replica in memory without it: there a poll that lands on another replica
 * gets 404, which the client reads as an outcome it never learned (the safe
 * side; production has Redis). A replica that stops mid-wait leaves the
 * operation pending until it expires: the client reads that the same way, as
 * it read a cut request before.
 */
import { randomUUID } from "node:crypto";
import { asMachineOperationId, type JsonValue, type MachineOperationId, type MachineOperationView, type ServerId } from "@botiverse/raft-shared";
import { getRedis, isRedisAvailable } from "../redis";

export const MACHINE_OPERATION_TTL_SECONDS = 10 * 60;

/** The HTTP status and JSON body the request would have answered. */
export type MachineOperationAnswer = { status: number; body: object };

/**
 * Who may read an operation: the person who started it, on its original Server, through the surface
 * that started it (`web`, or `voice:<App record id>`). A read through another
 * surface is refused like an unknown id (Tenny, #14843), so an App token cannot
 * read a web operation of the same person, nor the web an App's.
 */
export type MachineOperationOwner = { userId: string; serverId: ServerId; surface: string };

type Stored = MachineOperationOwner & ({ state: "pending" } | ({ state: "done" } & MachineOperationAnswer));

const key = (operationId: string) => `slock:machine-operation:${operationId}`;
const memory = new Map<string, { value: Stored; expiresAtMs: number }>();

async function put(operationId: string, value: Stored): Promise<void> {
  if (!isRedisAvailable()) {
    memory.set(operationId, { value, expiresAtMs: Date.now() + MACHINE_OPERATION_TTL_SECONDS * 1000 });
    for (const [id, entry] of memory) if (entry.expiresAtMs <= Date.now()) memory.delete(id);
    return;
  }
  await getRedis().set(key(operationId), JSON.stringify(value), "EX", MACHINE_OPERATION_TTL_SECONDS);
}

async function get(operationId: string): Promise<Stored | null> {
  if (!isRedisAvailable()) {
    const entry = memory.get(operationId);
    return entry && entry.expiresAtMs > Date.now() ? entry.value : null;
  }
  const raw = await getRedis().get(key(operationId));
  return raw ? JSON.parse(raw) as Stored : null;
}

/**
 * Starts `run` and answers its id once the pending record is written. `run`
 * never rejects into the void: a throw is kept as the 500 the request would
 * have answered.
 */
export async function startMachineOperation(
  owner: MachineOperationOwner,
  run: () => Promise<MachineOperationAnswer>,
  failure: MachineOperationAnswer,
): Promise<MachineOperationId> {
  const operationId = asMachineOperationId(randomUUID())!;
  await put(operationId, { ...owner, state: "pending" });
  void (async () => {
    let answer: MachineOperationAnswer;
    try {
      answer = await run();
    } catch {
      answer = failure;
    }
    await put(operationId, { ...owner, state: "done", ...answer }).catch(() => {});
  })();
  return operationId;
}

/** The same person, Server and surface; old records without a Server fail closed too. */
export async function readMachineOperation(owner: MachineOperationOwner, operationId: MachineOperationId): Promise<MachineOperationView | null> {
  const stored = await get(operationId);
  if (!stored || stored.userId !== owner.userId || stored.serverId?.toLowerCase() !== owner.serverId.toLowerCase() || stored.surface !== owner.surface) return null;
  // The body is a JSON response body (Redis stores it as JSON either way).
  return stored.state === "pending" ? { state: "pending" } : { state: "done", status: stored.status, body: stored.body as JsonValue };
}

/** Test seam: forget the in-memory operations. */
export function resetMachineOperationsForTests(): void {
  memory.clear();
}
