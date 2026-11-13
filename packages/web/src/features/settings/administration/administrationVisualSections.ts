import { WorkspaceProductAnalyticsSection } from "../../../components/settings/UsageDataSettings";
import { AdminsSection } from "./AdminsSection";
import { SystemChannelsSection } from "./SystemChannelsSection";
import { InvitesSection } from "./InvitesSection";
import { JoinLinksSection } from "./JoinLinksSection";
import { PreJoinAgreementSection } from "./PreJoinAgreementSection";
import { OnboardingAgentSection } from "./OnboardingAgentSection";
import { ServerTranslationSection } from "./ServerTranslationSection";
import { MemberPermissionsSection } from "./MemberPermissionsSection";

// Visual-testing render targets: components.settings.admins.* cases
// capture ONE section each instead of the shared tab top — without this every
// administration case screenshotted the identical first viewport of the tab
// (Slock task #333). Keys follow the case-id suffix.
export const ADMINISTRATION_VISUAL_SECTIONS = {
  admins: AdminsSection,
  // Insertion order mirrors AdministrationTabContent — the full-height case
  // stacks Object.values of this map, so system-channels must sit right after
  // admins to match the real route (and Android's canonical order, task #388).
  "system-channels": SystemChannelsSection,
  invites: InvitesSection,
  "join-links": JoinLinksSection,
  "pre-join-agreement": PreJoinAgreementSection,
  onboarding: OnboardingAgentSection,
  translation: ServerTranslationSection,
  "product-analytics": WorkspaceProductAnalyticsSection,
  "member-permissions": MemberPermissionsSection,
} as const;
