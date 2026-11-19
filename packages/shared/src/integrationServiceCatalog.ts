// The well-known services Raft recognises by name, with the other names
// people and agents use for them. One list, so the product event that counts
// what agents ask for (`integration_service_requested`) and the Apps page can
// share the same keys. The keys themselves are `REQUESTED_SERVICE_KEYS` in
// productEvents.ts (that file imports nothing); this file adds the aliases.
// Owner of what is on the list: the Apps side (AppFather).

import { REQUESTED_SERVICE_KEYS, type RequestedServiceKey } from "./productEvents";

/**
 * Other names for each service, in any case and with any punctuation (they
 * are compared after `normalizeServiceName`). The key itself always matches
 * and need not be repeated. An MCP template key that differs from the service
 * key (`docs`, `drive`, ...) is listed as an alias.
 */
export const REQUESTED_SERVICE_ALIASES: Record<RequestedServiceKey, readonly string[]> = {
  gmail: ["google mail", "googlemail"],
  google_docs: ["docs", "gdocs", "google doc", "google documents"],
  google_drive: ["drive", "gdrive"],
  google_calendar: ["calendar", "gcal", "gcalendar", "google cal"],
  google_sheets: ["sheets", "gsheets", "google sheet", "google spreadsheets"],
  google_slides: ["slides", "gslides", "google slide"],
  notion: [],
  linear: [],
  slack: [],
  github: ["gh"],
  gitlab: [],
  jira: ["atlassian jira"],
  confluence: ["atlassian confluence"],
  atlassian: [],
  figma: [],
  asana: [],
  trello: [],
  monday: ["monday.com", "mondaycom"],
  clickup: [],
  airtable: [],
  todoist: [],
  hubspot: [],
  salesforce: ["sfdc"],
  zendesk: [],
  intercom: [],
  stripe: [],
  shopify: [],
  sentry: [],
  datadog: [],
  pagerduty: [],
  supabase: [],
  vercel: [],
  cloudflare: [],
  aws: ["amazon web services"],
  postgres: ["postgresql"],
  discord: [],
  telegram: [],
  whatsapp: [],
  x: ["twitter", "x.com", "x twitter"],
  linkedin: [],
  youtube: [],
  zoom: [],
  microsoft_teams: ["teams", "ms teams", "msteams"],
  outlook: ["microsoft outlook", "outlook mail"],
  onedrive: ["microsoft onedrive"],
  dropbox: [],
  zapier: [],
  calendly: [],
  perplexity: [],
  workiq: ["work iq", "microsoft work iq"],
};

const TRAILING_WORDS = ["mcpserver", "mcp", "integration", "connector", "app", "api"];

/** Lower case, letters and digits only, and one trailing "mcp" / "app" / "api" style word dropped. */
export function normalizeServiceName(raw: string): string {
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const word of TRAILING_WORDS) {
    if (compact.length > word.length && compact.endsWith(word)) return compact.slice(0, -word.length);
  }
  return compact;
}

const SERVICE_BY_NAME: ReadonlyMap<string, RequestedServiceKey> = (() => {
  const map = new Map<string, RequestedServiceKey>();
  for (const key of REQUESTED_SERVICE_KEYS) {
    for (const name of [key, ...REQUESTED_SERVICE_ALIASES[key]]) {
      const normalized = normalizeServiceName(name);
      const taken = map.get(normalized);
      if (taken && taken !== key) throw new Error(`integrationServiceCatalog: "${name}" names both ${taken} and ${key}`);
      map.set(normalized, key);
    }
  }
  return map;
})();

/**
 * The listed service a typed name means, or `other`. Exact match on the
 * normalized name only: a name that merely contains a service ("notion to
 * linear sync") is `other`. Never returns any part of the input.
 */
export function matchRequestedService(raw: unknown): RequestedServiceKey | "other" {
  if (typeof raw !== "string" || raw.length > 200) return "other";
  return SERVICE_BY_NAME.get(normalizeServiceName(raw)) ?? "other";
}
