import { SERVER_LABS_UI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { LabsSection } from "./LabsSection";

export function LabsTabContent() {
  const labsUiEnabled = useServerFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY).enabled;
  return labsUiEnabled ? <LabsSection /> : null;
}
