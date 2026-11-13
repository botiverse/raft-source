// `workspace_artifacts_v0` is answered by the deployment, not by a per-server
// flag row (services/deploymentAnsweredFlags.ts; Artifacts runs wherever the
// deployment has its storage and its content origin:
// apps/artifacts/deployment.ts). A test says which deployment it runs as with
// `__answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true | false)`,
// the same for every server, as a real deployment answers;
// this takes that back after each test, so the next one starts from what the
// test process really has (no storage, no content origin: no Artifacts).
//
// Imports only that leaf module, so no test's mocks see a module loaded early.
import { afterEach } from "vitest";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

afterEach(() => {
  // Shared's WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, spelled out to keep this file's imports to the leaf.
  __answerFlagForTests("workspace_artifacts_v0", undefined);
});
