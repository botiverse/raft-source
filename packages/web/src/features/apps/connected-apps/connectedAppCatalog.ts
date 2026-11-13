import { buttonVariants } from "@botiverse/raft-ui";
import { OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";
import type { ConnectedAppCategory } from "./connectedAppTypes";

export const CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS = OAUTH_CLIENT_CATEGORIES.map((value) => ({ value }));

// Category enum values are data; the display labels live in the catalog.
// The marketplace card is the click target; its "Install" is the cue drawn as
// raft-ui's outline Button at md (32px, text-control), not a second button.
export const CONNECTED_APP_INSTALL_CUE_CLASS = buttonVariants({ variant: "outline", size: "md" }).root({
  className: "pointer-events-none",
});

export const CONNECTED_APP_CATEGORY_LABEL_ID: Record<string, MessageId> = {
  all: "settings.connectedApps.categoryAll",
  "AI & Automation": "settings.connectedApps.categoryAiAutomation",
  Communication: "settings.connectedApps.categoryCommunication",
  "Productivity & Collaboration": "settings.connectedApps.categoryProductivity",
  "Developer Tools": "settings.connectedApps.categoryDeveloperTools",
  "Data & Analytics": "settings.connectedApps.categoryDataAnalytics",
  "Business Ops": "settings.connectedApps.categoryBusinessOps",
  Infrastructure: "settings.connectedApps.categoryInfrastructure",
  "Content & Creative": "settings.connectedApps.categoryContentCreative",
  Other: "settings.connectedApps.categoryOther",
};

export function matchesConnectedAppFilter(
  app: { name: string; category: ConnectedAppCategory; description?: string | null; developer?: string | null; clientId?: string | null },
  normalizedSearch: string,
  category: ConnectedAppCategory | "all",
) {
  if (category !== "all" && app.category !== category) return false;
  if (!normalizedSearch) return true;
  return [app.name, app.description, app.developer, app.clientId]
    .some((value) => value?.toLowerCase().includes(normalizedSearch));
}
