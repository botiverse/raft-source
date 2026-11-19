// Vitest CLI flags whose next argument is (or may be) their value, not a test
// file: the test-run log (testRunLog.ts) drops them and their values, keeping
// only the test files. For the log only: a file wrongly taken as a value costs
// a line's detail. The web runner keeps its own narrow list
// (packages/web/scripts/splitRunnerArgs.ts), where that would change which
// tests run.
export const VITEST_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-t",
  "--testNamePattern",
  "--testTimeout",
  "--hookTimeout",
  "--maxWorkers",
  "--minWorkers",
  "--pool",
  "--reporter",
  "--outputFile",
  "--shard",
  "--bail",
  "--retry",
  "--changed",
  "--mode",
  "--config",
  "-c",
  "--root",
  "-r",
  "--dir",
  "--project",
  "--environment",
  "--exclude",
]);

// Dotted option groups (`--coverage.reporter html`, `--sequence.seed 1`).
// Some of them are boolean (`--coverage.enabled`), so only the log treats
// them as taking a value.
const VALUE_FLAG_PREFIXES = ["--coverage.", "--sequence."];

export function isDottedValueFlag(arg: string): boolean {
  return !arg.includes("=") && VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix));
}
