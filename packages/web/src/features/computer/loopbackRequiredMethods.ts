import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";

/**
 * OpenCode sign-ins this page has seen end as `loopback_required` (only a
 * browser on the Computer itself could finish them), per Computer, runtime,
 * provider and method, for the rest of this session: the provider list
 * shows them greyed out with why, so nobody starts one again from here.
 * Kept in memory only; a reload, or OpenCode changing its method, asks again.
 */
const seen = new Set<string>();

function keyOf(machineId: string, runtime: RuntimeAuthRuntime, providerId: string, method: string): string {
  return JSON.stringify([machineId, runtime, providerId, method]);
}

export function rememberLoopbackRequired(machineId: string, runtime: RuntimeAuthRuntime, providerId: string, method: string): void {
  seen.add(keyOf(machineId, runtime, providerId, method));
}

export function isLoopbackRequired(machineId: string, runtime: RuntimeAuthRuntime, providerId: string, method: string): boolean {
  return seen.has(keyOf(machineId, runtime, providerId, method));
}

/** Tests only. */
export function __clearLoopbackRequiredForTests(): void {
  seen.clear();
}
