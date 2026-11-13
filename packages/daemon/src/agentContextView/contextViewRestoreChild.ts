import { writeFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { contextViewRestoreFailure, restoreContextViewSource, type ContextViewRestored, type ContextViewRestoreRequest } from "./contextViewRestore";

/**
 * `<self> __restore-context-view`: one View Context restore in a child process
 * of this binary, so that a large session's parsing and replay stop the child
 * and not the daemon, and all its memory goes back when it exits.
 *
 * stdin: one `ContextViewRestoreRequest` as JSON. stdout: one line of JSON with
 * `{outcome, attrs}`, then the serialized result body, as it will be posted.
 */
export const CONTEXT_VIEW_RESTORE_CHILD_MODE = "__restore-context-view";

export function encodeContextViewRestored(restored: ContextViewRestored): string {
  return `${JSON.stringify({ outcome: restored.outcome, attrs: restored.attrs })}\n${restored.json}`;
}

/** What the child cost, for setting the limits, and to prove in the native smoke that the heap limit took effect. */
function childCostAttrs(): Record<string, number> {
  return {
    child_heap_limit_mb: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20),
    child_max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}

/**
 * Linux: this child goes first if the machine runs out of memory, ahead of the
 * daemon and the agents it shares a cgroup with. Raising needs no privilege.
 */
function preferOomKill(): void {
  if (process.platform !== "linux") return;
  try {
    writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {
    // Best effort: the heap limit still applies.
  }
}

export async function runContextViewRestore(stdin: string, restore = restoreContextViewSource): Promise<string> {
  let restored: ContextViewRestored;
  try {
    restored = await restore(JSON.parse(stdin) as ContextViewRestoreRequest);
  } catch (error) {
    // Past V8's string limit (or an ArrayBuffer it can't allocate): the view itself is too big.
    restored = error instanceof RangeError
      ? contextViewRestoreFailure("too_large", "view_over_runtime_limit", { error_class: error.name })
      : contextViewRestoreFailure("read_failed", "exception", { error_class: error instanceof Error ? error.name : "Error" });
  }
  return encodeContextViewRestored({ ...restored, attrs: { ...restored.attrs, ...childCostAttrs() } });
}

export async function runContextViewRestoreChildMain(): Promise<number> {
  preferOomKill();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const output = await runContextViewRestore(Buffer.concat(chunks).toString("utf8"));
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
  });
  // The Kimi SDK can leave handles open; nothing is left to do here.
  process.exit(0);
}
