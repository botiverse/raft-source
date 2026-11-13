import assert from "node:assert/strict";
import {
  exposeWebBuildIdentity,
} from "../src/buildIdentity";
import type {
  FrontendReleaseIdentity,
} from "../src/buildIdentity";

test("release bootstrap exposes the frontend identity on window and the document dataset", () => {
  const targetWindow = {} as Pick<Window, "__RAFT_BUILD_IDENTITY__" | "__RAFT_FRONTEND_RELEASE_IDENTITY__">;
  const identity: FrontendReleaseIdentity = Object.freeze({
    releaseId: "release-abc",
    commitSha: "abc",
    builtAt: "2026-07-22T00:00:00Z",
    branch: "staging",
    deploymentEnvironment: "staging",
  });
  const dataset: DOMStringMap = {};

  exposeWebBuildIdentity(
    targetWindow,
    { documentElement: { dataset } } as Pick<Document, "documentElement">,
    identity,
  );

  assert.deepEqual(targetWindow.__RAFT_FRONTEND_RELEASE_IDENTITY__, identity);
  assert.equal(dataset.raftFrontendReleaseId, identity.releaseId);
  assert.equal(dataset.raftBuildSha, identity.commitSha);
});
