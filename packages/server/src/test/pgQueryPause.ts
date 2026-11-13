// Real-PostgreSQL lock tests: pause one application query at the pg driver,
// with everything its transaction took so far held, to observe who waits on
// whom. Install once per test, uninstall in its finally.
import pg from "pg";

/** Pauses the first app query the armed matcher accepts, at the driver, with everything its transaction took so far held. */
export type ArmedPause = { match: (text: string, values: readonly unknown[]) => boolean; reached: () => void; released: Promise<void> };
let armedPause: ArmedPause | null = null;
const originalClientQuery = pg.Client.prototype.query;
export function installQueryPauseHook(): void {
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const config = args[0] as string | { text?: string; values?: unknown[] } | undefined;
    const text = typeof config === "string" ? config : config?.text;
    const values = Array.isArray(args[1]) ? args[1] as unknown[] : (typeof config === "object" && config?.values) || [];
    const pause = armedPause;
    if (pause && text && pause.match(text, values)) {
      armedPause = null;
      pause.reached();
      return pause.released.then(() => (originalClientQuery as (...a: unknown[]) => unknown).apply(this, args));
    }
    return (originalClientQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof originalClientQuery;
}
export function pauseQuery(match: ArmedPause["match"]) {
  let reached!: () => void;
  const atPause = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  armedPause = { match, reached, released };
  return { atPause, release, restore: () => { armedPause = null; release(); } };
}

export function uninstallQueryPauseHook(): void {
  armedPause = null;
  pg.Client.prototype.query = originalClientQuery;
}
