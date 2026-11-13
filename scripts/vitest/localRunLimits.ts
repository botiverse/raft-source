import { RunRecordReporter } from "./runRecordReporter";

// Local Vitest runs share one developer/agent host, so size workers and heap
// explicitly instead of by CPU count: one web run once grew a fork to 15 GiB
// and another spawned 64 Node processes. Used by the web, server and daemon
// configs; CI keeps each package's own sizing.
//
// The heap cap bounds only the V8 heap of each fork. jsdom, Buffers, native
// addons and other off-heap allocations (e.g. node:assert building a diff of a
// DOM node) are outside it, so a fork's RSS can exceed it by far. The real
// bound for an agent is its cgroup memory limit.

export const LOCAL_DEFAULT_MAX_WORKERS = 2;
// Server and daemon: one worker locally. Several server workers at once (from
// sub-agents passing --maxWorkers or many files) were OOM-killed six times on
// one shared host on 2026-11-04; one worker on one file was fine.
export const SHARED_HOST_MAX_WORKERS = 1;
export const DEFAULT_MAX_OLD_SPACE_MB = 4096;

/**
 * CI when CI is "true" or "1", or under GitHub Actions (which always sets
 * CI=true too); CI=false / CI=0 / unset are local runs.
 */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

export function positiveIntegerEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/**
 * Local worker count: RAFT_TEST_MAX_WORKERS, else the package's default (2 for
 * web). For web a CLI --maxWorkers still wins; server and daemon also add
 * localWorkerCapPlugin, which holds a run to this count.
 */
export function localMaxWorkers(
  env: NodeJS.ProcessEnv = process.env,
  defaultWorkers: number = LOCAL_DEFAULT_MAX_WORKERS,
): number {
  return positiveIntegerEnv("RAFT_TEST_MAX_WORKERS", env) ?? defaultWorkers;
}

/** The worker count a run may use, and the line to print when it was lowered. */
export function clampWorkers(
  label: string,
  requested: number | undefined,
  cap: number,
): { maxWorkers: number; message?: string } {
  if (requested === undefined || requested <= cap) return { maxWorkers: requested ?? cap };
  return {
    maxWorkers: cap,
    message: `[raft] ${label} tests: maxWorkers clamped ${requested} → ${cap} on a shared host; set RAFT_TEST_MAX_WORKERS=${requested} to allow`,
  };
}

type WorkerConfig = { maxWorkers?: number };

// Holds a local run to `cap` workers whatever the CLI asked for. The config's
// own maxWorkers is overridden by `--maxWorkers N` and VITEST_MAX_WORKERS, so
// this clamps the resolved config after Vitest merged them (configureVitest
// runs before any pool starts). It covers `pnpm test` and a direct
// `vitest run` alike. RAFT_TEST_MAX_WORKERS raises the cap. Other knobs
// (`--fileParallelism`, `--pool`) take their worker count from maxWorkers too.
export function localWorkerCapPlugin(options: { label: string; cap: number; log?: (line: string) => void }) {
  const log = options.log ?? ((line: string) => console.warn(line));
  return {
    name: "raft-test-worker-cap",
    configureVitest({ vitest, project }: { vitest: { config: WorkerConfig }; project: { config: WorkerConfig } }) {
      const requested = Math.max(vitest.config.maxWorkers ?? 0, project.config.maxWorkers ?? 0) || undefined;
      const { maxWorkers, message } = clampWorkers(options.label, requested, options.cap);
      if (!message) return;
      vitest.config.maxWorkers = maxWorkers;
      project.config.maxWorkers = maxWorkers;
      log(message);
    },
  };
}

// Forks inherit NODE_OPTIONS; a caller-supplied --max-old-space-size there is
// respected unless RAFT_TEST_MAX_OLD_SPACE_MB asks for a specific cap.
export function forkHeapExecArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = positiveIntegerEnv("RAFT_TEST_MAX_OLD_SPACE_MB", env);
  if (explicit === undefined && /--max-old-space-size[=\s]/.test(env.NODE_OPTIONS ?? "")) return [];
  return [`--max-old-space-size=${explicit ?? DEFAULT_MAX_OLD_SPACE_MB}`];
}

// Writes ~/.cache/raft-tests/<runId>.json (see runRecordReporter.ts). Added
// through configureVitest so it survives a CLI --reporter override, which
// replaces config `reporters`.
export function runRecordPlugin(options: { packageName: string; dom: boolean; worktree: string }) {
  return {
    name: "raft-test-run-record",
    configureVitest({ vitest }: { vitest: { config: { reporters: unknown[] } } }) {
      if (vitest.config.reporters.some((entry) => entry instanceof RunRecordReporter)) return;
      vitest.config.reporters.push(new RunRecordReporter(options));
    },
  };
}
