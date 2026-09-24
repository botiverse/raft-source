const resetCallbacks = new Set<() => void>();

export function registerMessagesSyncCoreReset(callback: () => void): void {
  resetCallbacks.add(callback);
}

export function triggerMessagesSyncCoreReset(): void {
  for (const callback of resetCallbacks) callback();
}
