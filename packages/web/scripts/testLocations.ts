/**
 * Where the web package's Vitest tests live (paths relative to packages/web).
 *
 * - tests/: cross-feature tests, e2e, messagesBaseline, helpers and fixtures.
 * - src/features/<feature>/tests/: tests of one feature, next to its code.
 *
 * Unit tests are *.test.ts, DOM tests are *.test.tsx, in both places.
 * vitest.config.ts and scripts/run-vitest-tests.ts take their default
 * selection from here. Files under src/features/<feature>/tests/ are not app
 * modules: the app typecheck (tsconfig.json), the app lint (.oxlintrc.json)
 * and scripts/check-module-shape.ts skip them; tests/tsconfig.json,
 * scripts/oxlint-tests.json and the `lint` script cover them instead. A test
 * file anywhere else in src fails scripts/check-module-shape.ts.
 *
 * A feature's tests/ folder holds only *.test.ts(x) files, and their helpers
 * and fixtures under tests/helpers/ and tests/fixtures/ (as in tests/), so
 * app code can never hide there out of the app's lint and typecheck.
 */
export const FEATURE_TEST_DIRS = "src/features/*/tests";

export function defaultTestIncludes(dom: boolean): string[] {
  const extension = dom ? "tsx" : "ts";
  return [`tests/**/*.test.${extension}`, `${FEATURE_TEST_DIRS}/**/*.test.${extension}`];
}

const TEST_PATH_RE = /^(?:tests|src\/features\/[^/]+\/tests)\//;

/**
 * A package-relative posix path that is test code rather than an app module:
 * under tests/ or src/features/<feature>/tests/, and nowhere else, so every
 * check that skips test code agrees with what Vitest collects.
 */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/**
 * A src path that looks like test code (a *.test.* or *.spec.* file, or a
 * file in a tests/ or __tests__/ directory) but is not where Vitest looks: it
 * would silently never run, so scripts/check-module-shape.ts fails on it.
 */
export function isMisplacedTestPath(path: string): boolean {
  if (!path.startsWith("src/") || isTestPath(path)) return false;
  return /\.(?:test|spec)\.tsx?$/.test(path) || /\/(?:tests|__tests__)\//.test(path);
}

const FEATURE_TEST_FILE_RE = /^src\/features\/[^/]+\/tests\/(?:.*\.test\.tsx?|(?:.*\/)?(?:helpers|fixtures)\/.+)$/;

/**
 * A file in a feature's tests/ folder that is neither a test nor under its
 * helpers/ or fixtures/: scripts/check-module-shape.ts fails on it.
 */
export function isStrayFeatureTestFile(path: string): boolean {
  return /^src\/features\/[^/]+\/tests\//.test(path) && !FEATURE_TEST_FILE_RE.test(path);
}
