import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

interface RapInvocationContext {
  readonly eventId: string;
}

const invocationStorage = new AsyncLocalStorage<RapInvocationContext>();

/**
 * Mint and bind the OS-owned identity for one raised hook event.
 *
 * The callback receives the minted value so the registry can put it in the
 * hook envelope. There is deliberately no event-id input: no callable entry
 * can turn a caller-chosen string into the identity inherited by syscalls.
 */
export function runWithMintedRapEvent<T>(
  fn: (eventId: string) => Promise<T>,
): Promise<T> {
  const eventId = randomUUID();
  return invocationStorage.run({ eventId }, () => fn(eventId));
}

/** Undefined means the syscall was raised outside a hook and needs its own identity. */
export function currentRapEventId(): string | undefined {
  return invocationStorage.getStore()?.eventId;
}
