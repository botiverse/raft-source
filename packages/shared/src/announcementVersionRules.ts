export type AnnouncementLifecycleStatus = "draft" | "published" | "expired";
export type AnnouncementEffectiveStatus = AnnouncementLifecycleStatus | "scheduled";

export interface AnnouncementReplacement {
  id: string;
  version: number;
  at: string;
}

export interface AnnouncementVersionCandidate {
  id: string;
  seriesId: string | null;
  version: number;
  dismissalFloorVersion: number;
  status: AnnouncementLifecycleStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  deletedAt?: Date | null;
}

/**
 * Canonical series key (`coalesce(series_id, id)`): version 1 carries `seriesId = null`
 * and acts as the root ID for every subsequent version in the series.
 */
export function announcementSeriesKey(
  row: Pick<AnnouncementVersionCandidate, "id" | "seriesId">,
): string {
  return row.seriesId ?? row.id;
}

/**
 * Groups announcement rows by `announcementSeriesKey` while preserving input order
 * within each series bucket.
 */
export function groupAnnouncementsBySeries<
  T extends Pick<AnnouncementVersionCandidate, "id" | "seriesId">,
>(rows: readonly T[]): Map<string, T[]> {
  const bySeries = new Map<string, T[]>();
  for (const row of rows) {
    const key = announcementSeriesKey(row);
    const bucket = bySeries.get(key);
    if (bucket) bucket.push(row);
    else bySeries.set(key, [row]);
  }
  return bySeries;
}

/**
 * Versions (task #38, #14892). A row is replaced once a later published or expired
 * undeleted version of its series has started (`startsAt <= now`). Expiring or
 * ending the later version does not bring an earlier one back.
 *
 * Returns the earliest-started later version (ties broken by ascending version),
 * or `null` when no later version in the series has taken over yet.
 */
export function findAnnouncementReplacement(
  row: Pick<AnnouncementVersionCandidate, "id" | "seriesId" | "version">,
  series: readonly (Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "status" | "startsAt"
  > & { deletedAt?: Date | null })[],
  now: Date,
): AnnouncementReplacement | null {
  const targetSeriesKey = announcementSeriesKey(row);
  const nowMs = now.getTime();
  const later = series
    .filter(
      (other) =>
        other.deletedAt == null &&
        announcementSeriesKey(other) === targetSeriesKey &&
        other.version > row.version &&
        (other.status === "published" || other.status === "expired") &&
        other.startsAt !== null &&
        other.startsAt.getTime() <= nowMs,
    )
    .sort(
      (a, b) => a.startsAt!.getTime() - b.startsAt!.getTime() || a.version - b.version,
    )[0];
  return later
    ? { id: later.id, version: later.version, at: later.startsAt!.toISOString() }
    : null;
}

/**
 * Effective lifecycle status at `now`, accounting for series replacement (`replacedBy`),
 * future schedules (`startsAt > now`), and natural end (`endsAt <= now`).
 */
export function effectiveAnnouncementStatus(
  row: Pick<AnnouncementVersionCandidate, "status" | "startsAt" | "endsAt">,
  now: Date,
  replacedBy: AnnouncementReplacement | null = null,
): AnnouncementEffectiveStatus {
  if (row.status !== "published") return row.status;
  if (replacedBy) return "expired";
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return "scheduled";
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return "expired";
  return "published";
}

/**
 * Single authoritative predicate for whether `row` is the currently active/displayed
 * version of its series at `now`: undeleted, published, started
 * (`startsAt !== null && startsAt <= now`), not yet ended, and not replaced by any
 * started undeleted later version in `series`.
 */
export function isAnnouncementVersionActive(
  row: Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "status" | "startsAt" | "endsAt"
  > & { deletedAt?: Date | null },
  series: readonly (Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "status" | "startsAt"
  > & { deletedAt?: Date | null })[],
  now: Date,
): boolean {
  if (row.deletedAt != null || row.startsAt === null) return false;
  const replacedBy = findAnnouncementReplacement(row, series, now);
  return effectiveAnnouncementStatus(row, now, replacedBy) === "published";
}

/**
 * Computes `dismissalFloorVersion` when publishing `draft`:
 * - Version 1 keeps its floor (`1`).
 * - Later versions set floor = `draft.version` when `reshowDismissed` is true
 *   (or no non-draft undeleted earlier version exists), and otherwise inherit the
 *   latest published/expired undeleted earlier version's `dismissalFloorVersion`.
 */
export function resolveAnnouncementDismissalFloorVersion(
  draft: Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "dismissalFloorVersion"
  >,
  series: readonly (Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "status" | "dismissalFloorVersion"
  > & { deletedAt?: Date | null })[],
  reshowDismissed?: boolean,
): number {
  if (draft.version <= 1) return draft.dismissalFloorVersion;
  const targetSeriesKey = announcementSeriesKey(draft);
  const previous = [...series]
    .filter(
      (row) =>
        row.deletedAt == null &&
        announcementSeriesKey(row) === targetSeriesKey &&
        row.version < draft.version &&
        row.status !== "draft",
    )
    .sort((a, b) => a.version - b.version)
    .pop();
  return reshowDismissed || !previous ? draft.version : previous.dismissalFloorVersion;
}

/**
 * Whether `dismissedAnnouncementIds` suppresses `row`, either because `row.id`
 * itself was dismissed or because an earlier version in the same series with
 * `version >= row.dismissalFloorVersion && version < row.version` was dismissed.
 */
export function isAnnouncementDismissedBySeries(
  row: Pick<
    AnnouncementVersionCandidate,
    "id" | "seriesId" | "version" | "dismissalFloorVersion"
  >,
  series: readonly Pick<AnnouncementVersionCandidate, "id" | "seriesId" | "version">[],
  dismissedAnnouncementIds: ReadonlySet<string>,
): boolean {
  if (dismissedAnnouncementIds.has(row.id)) return true;
  if (row.dismissalFloorVersion >= row.version) return false;
  const targetSeriesKey = announcementSeriesKey(row);
  return series.some(
    (earlier) =>
      announcementSeriesKey(earlier) === targetSeriesKey &&
      earlier.version >= row.dismissalFloorVersion &&
      earlier.version < row.version &&
      dismissedAnnouncementIds.has(earlier.id),
  );
}
