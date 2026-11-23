import { OAUTH_CLIENT_CATEGORIES } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";
import type { ConnectedAppCategory } from "./connectedAppTypes";

export const CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS = OAUTH_CLIENT_CATEGORIES.map((value) => ({ value }));

/** The Apps page's cards (Yours, Discover and its Recommended): one column, two from md. */
export const CONNECTED_APPS_GRID_CLASS = "grid gap-3 md:grid-cols-2";

// Category enum values are data; the display labels live in the catalog.
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
