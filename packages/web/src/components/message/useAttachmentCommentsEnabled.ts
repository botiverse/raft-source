import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";

export function useAttachmentCommentsEnabled(): boolean {
  return useServerFeatureFlag(ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY).enabled;
}
