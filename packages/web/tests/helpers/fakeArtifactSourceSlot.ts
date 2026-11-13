// The tests' fakeArtifactSourceSlot (aliased in vitest.config.ts): the
// Artifacts fake data source answers in tests, loaded only when
// artifactSource.ts first loads, as when it imported the fake directly.
export { fakeArtifactEntry as fakeArtifactSourceSlot } from "../../src/apps/artifacts/fakeArtifactSource";
