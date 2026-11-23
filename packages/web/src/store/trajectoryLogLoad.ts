/**
 * Single-flight runner for `loadTrajectoryLog`.
 *
 * A trajectory-log response is dropped when `trajectoryHydrateGeneration`
 * moved while it was in flight (an epoch re-baseline by `loadAgents` or
 * `resetActivitySeq`); that stale-drop protection stays in the store. Without
 * a retry, a load issued during bootstrap is dropped and an idle agent's
 * Activity tab stays empty until a remount or new activity. So a load whose
 * generation moved runs once more for the current generation.
 *
 * No storm: concurrent calls for the same key share one run (a call that
 * arrives mid-flight asks for one more pass, so a reload never misses rows
 * written after the in-flight request started), and generation-driven retries
 * are capped per run.
 */
const MAX_GENERATION_RETRIES = 3;

interface Run {
  promise: Promise<void>;
  rerun: boolean;
}

const runs = new Map<string, Run>();

export function loadForCurrentGeneration(
  key: string,
  currentGeneration: () => number,
  attempt: () => Promise<void>,
): Promise<void> {
  const existing = runs.get(key);
  if (existing) {
    existing.rerun = true;
    return existing.promise;
  }
  const run: Run = { promise: Promise.resolve(), rerun: false };
  run.promise = (async () => {
    let generationRetries = 0;
    try {
      for (;;) {
        run.rerun = false;
        const generation = currentGeneration();
        await attempt();
        if (currentGeneration() !== generation && generationRetries < MAX_GENERATION_RETRIES) {
          generationRetries += 1;
          continue;
        }
        if (!run.rerun) return;
      }
    } finally {
      runs.delete(key);
    }
  })();
  runs.set(key, run);
  return run.promise;
}
