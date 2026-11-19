// The web test runner's arguments (run-vitest-tests.ts): Vitest flags (and
// the values of the flags below) go to Vitest; everything else is a test file
// or pattern, which selects what runs. Only these flags take the next
// argument as their value: one added here turns a test file after it into
// that value, and with no file left the runner runs the whole suite (e.g.
// `--changed tests/a.test.ts`). The test-run log has its own, wider list
// (scripts/vitest/vitestArgs.ts), where a dropped file costs only a detail.
export const WEB_RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-t",
  "--testNamePattern",
  "--testTimeout",
  "--hookTimeout",
  "--maxWorkers",
  "--pool",
  "--reporter",
  "--outputFile",
  "--shard",
]);

export function splitRunnerArgs(
  userArgs: readonly string[],
  normalizeTestArg: (arg: string) => string = (arg) => arg,
): { testArgs: string[]; vitestArgs: string[]; dom: boolean } {
  const testArgs: string[] = [];
  const vitestArgs: string[] = [];
  let dom = false;
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index]!;
    if (arg === "--") continue;
    if (arg === "--dom") {
      dom = true;
      continue;
    }
    if (arg.startsWith("-")) {
      vitestArgs.push(arg);
      if (WEB_RUNNER_VALUE_FLAGS.has(arg) && index + 1 < userArgs.length) {
        vitestArgs.push(userArgs[index + 1]!);
        index += 1;
      }
      continue;
    }
    testArgs.push(normalizeTestArg(arg));
  }
  return { testArgs, vitestArgs, dom };
}
