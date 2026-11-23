import type { RuntimeDetection, RuntimeDetectionCheckedRuntime } from "./core";

/**
 * task #1268: the runtime detection round runs in a child process
 * (`<self> __detect-runtimes`) so the daemon's `ready` no longer waits for a
 * synchronous probe round and the round can be killed at a real deadline.
 *
 * Wire format on the child's stdout: one JSON object per line.
 *   {"event":"checked", ...RuntimeDetectionCheckedRuntime}   per runtime, in RUNTIMES order
 *   {"event":"done","detection":RuntimeDetection}            once, last
 *   {"event":"error","message":string}                       instead of done when the round threw
 * The parent assembles a partial inventory from `checked` lines when the child
 * never reaches `done` (deadline, crash, cancel), so unfinished runtimes can be
 * named exactly.
 */
export const RUNTIME_DETECTION_CHILD_MODE = "__detect-runtimes";

export type RuntimeDetectionChildLine =
  | ({ event: "checked" } & RuntimeDetectionCheckedRuntime)
  | { event: "done"; detection: RuntimeDetection }
  | { event: "error"; message: string };

export function parseRuntimeDetectionChildLine(line: string): RuntimeDetectionChildLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = (parsed as { event?: unknown }).event;
  if (event === "checked") {
    const checked = parsed as { runtime?: unknown; available?: unknown };
    if (typeof checked.runtime !== "string" || typeof checked.available !== "boolean") return null;
    return parsed as RuntimeDetectionChildLine;
  }
  if (event === "done") {
    const detection = (parsed as { detection?: unknown }).detection;
    if (!detection || typeof detection !== "object" || !Array.isArray((detection as { ids?: unknown }).ids)) return null;
    return parsed as RuntimeDetectionChildLine;
  }
  if (event === "error") {
    return { event: "error", message: String((parsed as { message?: unknown }).message ?? "") };
  }
  return null;
}

/**
 * Child-mode main: run the detection round (`detectRuntimesAsync`: a driver's
 * asynchronous probe where it has one) and stream it. Exits 0 after `done`, 1
 * after `error`. Loaded only in the child (via the daemon entry's
 * `__detect-runtimes` dispatch), so the parent's module graph is not touched.
 */
export async function runRuntimeDetectionChildMain(
  deps: {
    detect?: (hooks: { onRuntimeChecked: (checked: RuntimeDetectionCheckedRuntime) => void }) => RuntimeDetection | Promise<RuntimeDetection>;
    write?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  let detect = deps.detect;
  if (!detect) {
    const { detectRuntimesAsync } = await import("./core");
    detect = (hooks) => detectRuntimesAsync(undefined, hooks);
  }
  try {
    const detection = await detect({
      onRuntimeChecked: (checked) => write(JSON.stringify({ event: "checked", ...checked })),
    });
    write(JSON.stringify({ event: "done", detection }));
    return 0;
  } catch (error) {
    write(JSON.stringify({ event: "error", message: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}
