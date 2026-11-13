/**
 * The command-line arguments of a raft-perf command. `pnpm --filter … <script> -- --flag`
 * passes the `--` through to the script, and node:util parseArgs would then read every
 * flag after it as a positional argument, so a leading `--` is dropped.
 */
export function cliArgs(argv: readonly string[] = process.argv): string[] {
  const args = argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}
