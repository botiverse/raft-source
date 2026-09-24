export type SearchTimeRange = "any" | "today" | "7d" | "30d";
export type SearchSort = "relevance" | "recent";
export type SearchScope = "mentioned" | "humans" | "agents";

export interface SearchMessageResultLike {
  id: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  createdAt: string;
}

export interface ThreadSearchResultGroup<T extends SearchMessageResultLike> {
  kind: "thread";
  key: string;
  threadId: string;
  parentMessageId: string;
  title: string;
  latestCreatedAt: string;
  hitCount: number;
  results: T[];
}

export interface MessageSearchResultGroup<T extends SearchMessageResultLike> {
  kind: "message";
  key: string;
  result: T;
}

export type SearchResultGroup<T extends SearchMessageResultLike> =
  | ThreadSearchResultGroup<T>
  | MessageSearchResultGroup<T>;

function getFiniteTimeMs(value: string): number | null {
  const timeMs = new Date(value).getTime();
  return Number.isFinite(timeMs) ? timeMs : null;
}

// Returns "" for an empty/absent parent message so the render layer can show
// the localized "Thread discussion" fallback (no baked-in English in group data).
function truncateThreadTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

export function buildTimeRangeParams(range: SearchTimeRange, now = new Date()): { after?: string; before?: string } {
  if (range === "any") return {};

  const before = new Date(now);
  const after = new Date(now);

  if (range === "today") {
    after.setHours(0, 0, 0, 0);
  } else if (range === "7d") {
    after.setDate(after.getDate() - 7);
  } else if (range === "30d") {
    after.setDate(after.getDate() - 30);
  }

  return {
    after: after.toISOString(),
    before: before.toISOString(),
  };
}

export function normalizeSearchTimeRange(value: string | null): SearchTimeRange {
  return value === "today" || value === "7d" || value === "30d" ? value : "any";
}

export function normalizeSearchSort(value: string | null): SearchSort {
  return value === "recent" ? "recent" : "relevance";
}

export function normalizeSearchScopes(values: readonly string[] | string | null): SearchScope[] {
  const rawValues = Array.isArray(values) ? values : values ? [values] : [];
  const seen = new Set<SearchScope>();
  for (const value of rawValues) {
    if (value === "mentioned" || value === "humans" || value === "agents") {
      seen.add(value);
    }
  }
  return (["mentioned", "humans", "agents"] as const).filter((scope) => seen.has(scope));
}

export function hasMeaningfulMessageSearchFilter(params: {
  senderId?: string | null;
  channelId?: string | null;
  timeRange: SearchTimeRange;
  scopes?: readonly SearchScope[];
}): boolean {
  return Boolean(params.senderId || params.channelId || params.timeRange !== "any" || params.scopes?.length);
}

export function getEffectiveMessageSearchSort(query: string, sort: SearchSort): SearchSort {
  return query.trim() ? sort : "recent";
}

// Typed descriptor (value + unit) instead of a preformatted string: the caller
// formats with the app's active intl locale via `intl.formatRelativeTime`, so
// relative times follow the Raft display language, not the browser system
// locale. Returns null when the timestamp is unusable → caller shows the
// localized "unknown time" copy.
export type SearchRelativeTimeParts = { value: number; unit: "minute" | "hour" | "day" };

export function getSearchRelativeTimeParts(value: string, now = Date.now()): SearchRelativeTimeParts | null {
  const timeMs = getFiniteTimeMs(value);
  if (timeMs == null) return null;

  const diffMs = timeMs - now;
  const absMs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < hour) {
    return { value: Math.round(diffMs / minute), unit: "minute" };
  }
  if (absMs < day) {
    return { value: Math.round(diffMs / hour), unit: "hour" };
  }
  return { value: Math.round(diffMs / day), unit: "day" };
}

export function groupMessageSearchResults<T extends SearchMessageResultLike>(results: T[]): SearchResultGroup<T>[] {
  const groups: SearchResultGroup<T>[] = [];
  const threadGroups = new Map<string, ThreadSearchResultGroup<T>>();

  for (const result of results) {
    if (!result.threadId || !result.parentMessageId) {
      groups.push({
        kind: "message",
        key: `message:${result.id}`,
        result,
      });
      continue;
    }

    const key = `thread:${result.threadId}`;
    const existing = threadGroups.get(key);
    if (existing) {
      existing.results.push(result);
      existing.hitCount += 1;
      const nextTimeMs = getFiniteTimeMs(result.createdAt);
      const currentTimeMs = getFiniteTimeMs(existing.latestCreatedAt);
      if (nextTimeMs != null && (currentTimeMs == null || nextTimeMs > currentTimeMs)) {
        existing.latestCreatedAt = result.createdAt;
      }
      continue;
    }

    const group: ThreadSearchResultGroup<T> = {
      kind: "thread",
      key,
      threadId: result.threadId,
      parentMessageId: result.parentMessageId,
      title: truncateThreadTitle(result.parentMessageContent ?? ""),
      latestCreatedAt: result.createdAt,
      hitCount: 1,
      results: [result],
    };
    threadGroups.set(key, group);
    groups.push(group);
  }

  return groups;
}
