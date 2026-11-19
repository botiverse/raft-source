// The web runner's argument split (splitRunnerArgs.ts): a test file after a
// flag stays a test file unless the flag is one of the runner's own value
// flags. A wider list (e.g. the test-run log's) took `tests/a.test.ts` as the
// value of `--changed`, and with no file left the runner ran the whole suite.
// Run by hand: pnpm exec vitest run packages/web/scripts/splitRunnerArgs.test.ts
import { expect, test } from "vitest";

import { splitRunnerArgs } from "./splitRunnerArgs";

test.each([
  [["--changed", "tests/a.test.ts"], ["tests/a.test.ts"], ["--changed"]],
  [["--bail", "tests/a.test.ts"], ["tests/a.test.ts"], ["--bail"]],
  [["--retry", "tests/a.test.ts"], ["tests/a.test.ts"], ["--retry"]],
  [["--project", "web", "tests/a.test.ts"], ["web", "tests/a.test.ts"], ["--project"]],
  [["--exclude", "x", "tests/a.test.ts"], ["x", "tests/a.test.ts"], ["--exclude"]],
])("%j keeps its test files", (args, testArgs, vitestArgs) => {
  expect(splitRunnerArgs(args)).toEqual({ testArgs, vitestArgs, dom: false });
});

test("the runner's own value flags take their value; --dom and -- are its own", () => {
  expect(splitRunnerArgs(["--dom", "-t", "name", "--", "--maxWorkers", "2", "tests/a.test.ts"])).toEqual({
    testArgs: ["tests/a.test.ts"],
    vitestArgs: ["-t", "name", "--maxWorkers", "2"],
    dom: true,
  });
});
