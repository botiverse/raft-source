// Artifacts runs where the deployment has its storage and its content origin
// (deployment.ts): that, and nothing in Feature Flag Admin, answers
// `workspace_artifacts_v0` for every server.
import assert from "node:assert/strict";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { __answerFlagForTests, deploymentAnswerOf } from "../../services/deploymentAnsweredFlags";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { artifactsConfigured } from "./deployment";

const STORE = {} as ArtifactR2Store;
const CONTENT = { ARTIFACTS_CONTENT_WORKER_TOKEN: "w".repeat(40), ARTIFACTS_CONTENT_DOMAIN: "content.example.test" };

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
  vi.unstubAllEnvs();
});

test("configured only with both the object storage and the content origin", () => {
  __setArtifactR2StoreForTests(STORE);
  assert.equal(artifactsConfigured(CONTENT), true);
  assert.equal(artifactsConfigured({}), false, "no content origin");
  assert.equal(artifactsConfigured({ ...CONTENT, ARTIFACTS_CONTENT_DOMAIN: "" }), false, "no content domain");
  assert.equal(artifactsConfigured({ ...CONTENT, ARTIFACTS_CONTENT_WORKER_TOKEN: "too-short" }), false, "a token the content Worker would not be signed by");
  __setArtifactR2StoreForTests(null);
  assert.equal(artifactsConfigured(CONTENT), false, "no storage: what a push answers 503 by");
  assert.equal(artifactsConfigured({}), false);
});

test("the deployment answers workspace_artifacts_v0, for any server, by what it has now", () => {
  // Without a test's own answer (the suite's setup gives none; a test before this one may have).
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, undefined);
  __setArtifactR2StoreForTests(null);
  assert.equal(deploymentAnswerOf(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY), false);
  __setArtifactR2StoreForTests(STORE);
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", CONTENT.ARTIFACTS_CONTENT_WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", CONTENT.ARTIFACTS_CONTENT_DOMAIN);
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", "");
  assert.equal(deploymentAnswerOf(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY), true);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "");
  assert.equal(deploymentAnswerOf(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY), false);
});
