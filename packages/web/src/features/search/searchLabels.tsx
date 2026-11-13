import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import type { SearchEntitySubtitle } from "./searchEntities";
import type { SearchScope, SearchSort, SearchTimeRange } from "./searchGrouping";

export const SEARCH_SCOPE_OPTIONS = ["mentioned", "humans", "agents"] as const satisfies readonly SearchScope[];
export const SEARCH_TIME_RANGES = ["any", "today", "7d", "30d"] as const satisfies readonly SearchTimeRange[];
export const SEARCH_SORTS = ["relevance", "recent"] as const satisfies readonly SearchSort[];

// Return the message KEY (not a localized string) so the callsite formats with
// the active locale — no string-branching on translated text.
export function getScopeOptionLabelId(scope: SearchScope): "search.scopeMe" | "search.scopeHumans" | "search.scopeAgents" {
  switch (scope) {
    case "mentioned":
      return "search.scopeMe";
    case "humans":
      return "search.scopeHumans";
    case "agents":
      return "search.scopeAgents";
  }
}

// An applied filter carries its count in machine type (DS `rf-filter__count`).
export function getScopeChipLabel(scopes: readonly SearchScope[], formatMessage: IntlShape["formatMessage"]): ReactNode {
  return scopes.length > 0
    ? formatMessage(
        { id: "search.scopeChip" },
        { count: <span key="count" className="font-mono text-mono-meta font-bold">{scopes.length}</span> },
      )
    : formatMessage({ id: "search.scope" });
}

// Localize an entity-result subtitle descriptor at render time (real @handles /
// descriptions pass through as-is; fallback labels format with the app locale).
export function formatEntitySubtitle(subtitle: SearchEntitySubtitle, formatMessage: IntlShape["formatMessage"]): string {
  switch (subtitle.kind) {
    case "channel":
      return formatMessage({ id: "search.channel" });
    case "computer":
      return subtitle.hostname
        ? formatMessage({ id: "search.entComputer" }, { hostname: subtitle.hostname })
        : formatMessage({ id: "search.badgeComputer" });
    case "agentDm":
      return formatMessage({ id: "search.entAgentDm" });
    case "selfDm":
      return formatMessage({ id: "search.entSelfDm" });
    case "text":
      return subtitle.text;
  }
}

export function getExclusiveSenderTypeScope(scopes: readonly SearchScope[]): "user" | "agent" | null {
  const hasHumans = scopes.includes("humans");
  const hasAgents = scopes.includes("agents");
  if (hasHumans === hasAgents) return null;
  return hasHumans ? "user" : "agent";
}

// Returns the message KEY; the callsite formats with the active locale. Title
// Case per stdrc case-doctrine (PR #2150/#2160/#2176) lives in the en catalog.
export function getTimeRangeLabelId(range: SearchTimeRange): "search.timeToday" | "search.timeLast7" | "search.timeLast30" | "search.timeAny" {
  switch (range) {
    case "today":
      return "search.timeToday";
    case "7d":
      return "search.timeLast7";
    case "30d":
      return "search.timeLast30";
    default:
      return "search.timeAny";
  }
}
