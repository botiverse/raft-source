import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { WorkspaceProductAnalyticsSection } from "../../../components/settings/UsageDataSettings";
import { AdminsSection } from "./AdminsSection";
import { SystemChannelsSection } from "./SystemChannelsSection";
import { InvitesSection } from "./InvitesSection";
import { JoinLinksSection } from "./JoinLinksSection";
import { PreJoinAgreementSection } from "./PreJoinAgreementSection";
import { OnboardingAgentSection } from "./OnboardingAgentSection";
import { ServerTranslationSection } from "./ServerTranslationSection";
import { MemberPermissionsSection } from "./MemberPermissionsSection";
import { ContextViewGrantsSection } from "./ContextViewGrantsSection";
import { ServerSsoSection } from "../sso/ServerSsoSection";

export function AdministrationTabContent() {
  const { capabilities } = useServerPermissions();
  return (
    <>
      {capabilities.changeMemberRoles && <AdminsSection />}
      {capabilities.changeChannelVisibility && <SystemChannelsSection />}
      <InvitesSection />
      <JoinLinksSection />
      {capabilities.editServerSettings && <PreJoinAgreementSection />}
      {capabilities.editServerSettings && <ServerSsoSection />}
      <OnboardingAgentSection />
      <ServerTranslationSection />
      {capabilities.editServerSettings && <WorkspaceProductAnalyticsSection />}
      <MemberPermissionsSection />
      <ContextViewGrantsSection />
    </>
  );
}
