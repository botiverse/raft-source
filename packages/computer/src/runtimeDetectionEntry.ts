/**
 * task #1268: the `__detect-runtimes` child the hosted daemon spawns for one
 * runtime detection round (streams JSON lines, returns the exit code). One
 * definition for every host that routes the mode: the Computer CLI entry
 * (Node / SEA) and Raft Desktop's argv guard, which imports it through
 * `@botiverse/raft-computer/lib`. The daemon is loaded only when the mode runs.
 */
export async function runContextViewRestoreChildEntry(): Promise<number> {
  const { runContextViewRestoreChildMain } = await import("@botiverse/raft-daemon/context-view-restore-child");
  return runContextViewRestoreChildMain();
}

export async function runRuntimeDetectionChildEntry(): Promise<number> {
  const { runRuntimeDetectionChildMain } = await import("@botiverse/raft-daemon/runtime-detection-child");
  return runRuntimeDetectionChildMain();
}
