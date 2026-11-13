// Whether this deployment runs Artifacts at all, and with it the answer of
// `workspace_artifacts_v0` (#proj-workspace:#278, #raft-architecture:#32).
//
// The key was Artifacts' rollout flag, per server, in Feature Flag Admin. The
// rollout is over (on for every server in production), so nothing reads those
// rows any more. What remains is a fact about the deployment: Artifacts needs
// object storage for its files and a content Worker for its pages, and a
// deployment without them (a self-hosted server that hasn't set them up, a
// bare local server) has no Artifacts. The key itself stays: old web tabs and
// App builds evaluate it, core gates the app's objects by it
// (FirstPartyApp.flag), and both now get this answer
// (platform/flags.ts answerAppFlagFromDeployment), the same for
// every server.
//
// One function says "configured", for the app's gate and for what a push
// answers without storage (publish.ts): they can't disagree.
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { answerAppFlagFromDeployment } from "../../platform/flags";
import { artifactR2Store } from "./blobStore";
import { contentFrameConfigured } from "./contentWorker";

/**
 * Whether this deployment has what Artifacts needs: the platform's
 * app-content bucket (`APP_STORAGE_R2_ENDPOINT`, `APP_STORAGE_R2_BUCKET` and
 * its credentials: blobStore.ts artifactR2Store) and the content origin
 * (`ARTIFACTS_CONTENT_WORKER_TOKEN`, `ARTIFACTS_CONTENT_DOMAIN`:
 * contentWorker.ts). To turn Artifacts on for a self-hosted server, configure
 * both (docs/development/workspace-artifacts.md, "Running Artifacts"); to
 * turn them off, leave one out.
 */
export function artifactsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return artifactR2Store() !== null && contentFrameConfigured(env);
}

answerAppFlagFromDeployment(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, () => artifactsConfigured());
