// Machine API keys used to be cached in localStorage as
// `slock_machine_apikey_<machineId>`. That copy was not scoped to a user and
// survived sign-out, so the next person on the browser (or any script that can
// read this origin's storage) could lift another account's machine key. The
// web no longer keeps the key anywhere; this purges any copy an older build
// left behind. Called once per load and on every sign-out path.
const MACHINE_API_KEY_STORAGE_PREFIX = "slock_machine_apikey_";

export function purgeStoredMachineKeys(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(MACHINE_API_KEY_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage unavailable (privacy mode, sandboxed embed): nothing to purge.
  }
}
