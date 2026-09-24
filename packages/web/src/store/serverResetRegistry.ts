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
}
