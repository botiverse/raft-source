// The edition a server test runs as (edition.ts), test infrastructure only.
//
// edition.ts says which build this is, and the export rewrites its one line
// (scripts/source-available/export-snapshot.ts), so the same test file runs
// in the cloud tree and in the source-available snapshot. Tests do not depend
// on that line: the setup file src/test/setup/edition.ts (vitest.config.ts
// `setupFiles`) replaces edition.ts's functions with ones that answer for the
// edition chosen here, "cloud" unless a test says otherwise. A test of what
// one edition does says so: `useEdition("source-available")` for a whole file,
// or `setEditionForTest(...)` inside one test (reset after each test).
//
// Nothing here is a switch for a running server: only the mock installed by
// the Vitest setup file reads this value. The real edition.ts, which a
// deployment loads, never imports it, so calling these outside Vitest
// changes nothing.
import { afterEach, beforeEach } from "vitest";

export type TestEdition = "cloud" | "source-available";

let current: TestEdition = "cloud";

/** The edition the mocked edition.ts answers for now. */
export function editionUnderTest(): TestEdition {
  return current;
}

/** Runs the rest of this test as `edition`; the setup file goes back to "cloud" after it. */
export function setEditionForTest(edition: TestEdition): void {
  current = edition;
}

/** Runs every test of the calling file (or describe block) as `edition`. */
export function useEdition(edition: TestEdition): void {
  beforeEach(() => {
    current = edition;
  });
  afterEach(() => {
    current = "cloud";
  });
}
