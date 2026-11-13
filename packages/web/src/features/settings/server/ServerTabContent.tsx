import ArchivedChannelsSection from "../../../components/settings/ArchivedChannelsSection";
import OrphanedJointChannelsSection from "../../../components/settings/OrphanedJointChannelsSection";
import ArchivedAgentsSection from "../../../components/settings/ArchivedAgentsSection";
import { ProfileSection } from "./ProfileSection";
import { PublicVisibilitySection } from "./PublicVisibilitySection";
import { DangerZoneSection } from "./DangerZoneSection";

export function ServerTabContent() {
  return (
    <>
      <ProfileSection />
      <PublicVisibilitySection />
      <ArchivedChannelsSection />
      <OrphanedJointChannelsSection />
      <ArchivedAgentsSection />
      <DangerZoneSection />
    </>
  );
}
