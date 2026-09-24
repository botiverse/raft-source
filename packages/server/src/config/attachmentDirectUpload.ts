import type { ServerId } from "@botiverse/raft-shared";
import {
  ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
  evaluateFeatureFlag,
} from "../services/featureFlagService.js";

export async function isAttachmentDirectUploadEnabledForServer(
  context: Readonly<{ serverId: ServerId; userId?: string }>,
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
    serverId: context.serverId,
    userId: context.userId,
  });
  return evaluation.enabled;
}
