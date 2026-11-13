/**
 * Server reset registry.
 *
 * Every server-scoped Zustand store calls `registerServerReset()` at module
 * load time to register its reset callback.  When the user switches servers,
 * `serverStore.setCurrent()` calls `triggerServerReset()` once, which fans out
 * to all registered stores atomically — no store can be forgotten.
 */

type ResetCallback = () => void;

const callbacks: ResetCallback[] = [];

export function registerServerReset(cb: ResetCallback): void {
  callbacks.push(cb);
}

export function triggerServerReset(): void {
  callbacks.forEach((cb) => cb());
  triggerAfterServerReset();
}

const afterCallbacks: ResetCallback[] = [];

/**
 * Runs after every store has reset, for work that fills the fresh slices
 * (task #164: seeding the last saved counts of the new server). Order among
 * the reset callbacks is import order, so a seed there could be wiped by a
 * store that resets after it.
 */
export function registerAfterServerReset(cb: ResetCallback): void {
  afterCallbacks.push(cb);
}

export function triggerAfterServerReset(): void {
  afterCallbacks.forEach((cb) => cb());
}
