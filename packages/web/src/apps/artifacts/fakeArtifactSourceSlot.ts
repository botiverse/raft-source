import type { FakeArtifactEntry } from "./artifactSource";

/**
 * Null in every build. The tests alias this module to
 * tests/helpers/fakeArtifactSourceSlot.ts (vitest.config.ts), so the fake
 * data source loads when artifactSource.ts first does, after the test file's
 * DOM, env stubs and mocks; no production module references the fake.
 */
export const fakeArtifactSourceSlot: FakeArtifactEntry | null = null;
