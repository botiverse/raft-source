/**
 * Narrow import leaf for announcement series replacement, active/displayed version
 * selection, effective status, and dismissal-floor carry-over so the API server
 * (`announcementService.ts`) and Feature Flag Admin Worker (`announcementAdmin.ts`)
 * share one implementation without importing the package root.
 */
export * from "./src/announcementVersionRules";
