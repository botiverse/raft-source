// Every server test runs as the edition src/test/edition.ts names ("cloud"
// unless the test chooses another), whatever line edition.ts carries: the
// private tree's "cloud" or the source-available snapshot's (the export
// rewrites that line). So the snapshot's suite tests the same behaviour as
// ours, and a test of the source-available edition (social login and SSO
// refused, the Raft License's user limit) tests it in both trees.
//
// Only edition.ts's functions are replaced; product code calls them without
// an argument, so each call reads the test's edition. An explicit argument is
// passed through. HUMAN_USER_LIMIT and RAFT_EDITION are the real ones.
// This is Vitest module mocking: a running server loads the real edition.ts.
import { afterEach, vi } from "vitest";
import { editionUnderTest, setEditionForTest } from "../edition";

vi.mock("../../edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../edition")>();
  return {
    ...actual,
    socialLoginAllowed: (edition: string = editionUnderTest()) => actual.socialLoginAllowed(edition),
    enterpriseSsoAllowed: (edition: string = editionUnderTest()) => actual.enterpriseSsoAllowed(edition),
    humanUserLimit: (edition: string = editionUnderTest()) => actual.humanUserLimit(edition),
  };
});

afterEach(() => {
  setEditionForTest("cloud");
});
