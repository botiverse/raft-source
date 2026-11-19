import { describe, expect, it } from "vitest";
import {
  announcementSeriesKey,
  effectiveAnnouncementStatus,
  findAnnouncementReplacement,
  groupAnnouncementsBySeries,
  isAnnouncementDismissedBySeries,
  isAnnouncementVersionActive,
  resolveAnnouncementDismissalFloorVersion,
  type AnnouncementVersionCandidate,
} from "../announcement-version-rules";

function candidate(
  overrides: Partial<AnnouncementVersionCandidate> & Pick<AnnouncementVersionCandidate, "id">,
): AnnouncementVersionCandidate {
  return {
    seriesId: null,
    version: 1,
    dismissalFloorVersion: 1,
    status: "published",
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: null,
    ...overrides,
  };
}

describe("announcementVersionRules", () => {
  it("resolves series key and groups series buckets cleanly", () => {
    const v1 = candidate({ id: "a-v1", seriesId: null, version: 1 });
    const v2 = candidate({ id: "a-v2", seriesId: "a-v1", version: 2 });
    const other = candidate({ id: "b-v1", seriesId: null, version: 1 });

    expect(announcementSeriesKey(v1)).toBe("a-v1");
    expect(announcementSeriesKey(v2)).toBe("a-v1");
    const grouped = groupAnnouncementsBySeries([v1, other, v2]);
    expect(grouped.get("a-v1")?.map((r) => r.id)).toEqual(["a-v1", "a-v2"]);
    expect(grouped.get("b-v1")?.map((r) => r.id)).toEqual(["b-v1"]);
  });

  it("replaces an earlier version only once a later published/expired version in the same series starts, and ending the later version never resurrects the earlier one", () => {
    const v1 = candidate({
      id: "v1",
      version: 1,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const v2Scheduled = candidate({
      id: "v2",
      seriesId: "v1",
      version: 2,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const unrelatedLater = candidate({
      id: "other-v2",
      seriesId: "other-v1",
      version: 2,
      startsAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const draftV3 = candidate({
      id: "v3-draft",
      seriesId: "v1",
      version: 3,
      status: "draft",
      startsAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const series = [v1, v2Scheduled, unrelatedLater, draftV3];

    const beforeV2 = new Date("2026-06-01T00:00:00.000Z");
    expect(findAnnouncementReplacement(v1, series, beforeV2)).toBeNull();
    expect(isAnnouncementVersionActive(v1, series, beforeV2)).toBe(true);
    expect(isAnnouncementVersionActive(v2Scheduled, series, beforeV2)).toBe(false);
    expect(effectiveAnnouncementStatus(v2Scheduled, beforeV2)).toBe("scheduled");

    const afterV2 = new Date("2026-07-02T00:00:00.000Z");
    const replacement = findAnnouncementReplacement(v1, series, afterV2);
    expect(replacement).toEqual({
      id: "v2",
      version: 2,
      at: "2026-07-01T00:00:00.000Z",
    });
    expect(effectiveAnnouncementStatus(v1, afterV2, replacement)).toBe("expired");
    expect(isAnnouncementVersionActive(v1, series, afterV2)).toBe(false);
    expect(isAnnouncementVersionActive(v2Scheduled, series, afterV2)).toBe(true);

    // Expiring v2 does not bring v1 back.
    const v2Expired: AnnouncementVersionCandidate = {
      ...v2Scheduled,
      status: "expired",
      endsAt: new Date("2026-07-03T00:00:00.000Z"),
    };
    const afterExpiry = new Date("2026-07-04T00:00:00.000Z");
    expect(isAnnouncementVersionActive(v1, [v1, v2Expired], afterExpiry)).toBe(false);
    expect(isAnnouncementVersionActive(v2Expired, [v1, v2Expired], afterExpiry)).toBe(false);
  });

  it("picks the earliest-started later version (breaking ties by ascending version) and refuses null startsAt for active display", () => {
    const v1 = candidate({ id: "v1", version: 1, startsAt: new Date("2026-01-01T00:00:00.000Z") });
    const v2 = candidate({ id: "v2", seriesId: "v1", version: 2, startsAt: new Date("2026-03-01T00:00:00.000Z") });
    const v3 = candidate({ id: "v3", seriesId: "v1", version: 3, startsAt: new Date("2026-03-01T00:00:00.000Z") });
    const unstarted = candidate({ id: "null-start", version: 1, startsAt: null });

    const now = new Date("2026-04-01T00:00:00.000Z");
    expect(findAnnouncementReplacement(v1, [v1, v3, v2], now)).toEqual({
      id: "v2",
      version: 2,
      at: "2026-03-01T00:00:00.000Z",
    });
    expect(isAnnouncementVersionActive(unstarted, [unstarted], now)).toBe(false);
  });

  it("computes dismissalFloorVersion and evaluates series dismissal carry-over identically across typo-fix and show-again versions", () => {
    const v1 = candidate({ id: "v1", version: 1, dismissalFloorVersion: 1 });
    const v2Draft = candidate({ id: "v2", seriesId: "v1", version: 2, dismissalFloorVersion: 2, status: "draft" });
    expect(resolveAnnouncementDismissalFloorVersion(v2Draft, [v1, v2Draft], false)).toBe(1);
    expect(resolveAnnouncementDismissalFloorVersion(v2Draft, [v1, v2Draft], true)).toBe(2);

    const v2 = { ...v2Draft, status: "published" as const, dismissalFloorVersion: 1 };
    const v3Draft = candidate({ id: "v3", seriesId: "v1", version: 3, dismissalFloorVersion: 3, status: "draft" });
    expect(resolveAnnouncementDismissalFloorVersion(v3Draft, [v1, v2, v3Draft], true)).toBe(3);

    const v3 = { ...v3Draft, status: "published" as const, dismissalFloorVersion: 3 };
    const v4Draft = candidate({ id: "v4", seriesId: "v1", version: 4, dismissalFloorVersion: 4, status: "draft" });
    expect(resolveAnnouncementDismissalFloorVersion(v4Draft, [v1, v2, v3, v4Draft], false)).toBe(3);

    const v4 = { ...v4Draft, status: "published" as const, dismissalFloorVersion: 3 };
    const series = [v1, v2, v3, v4];

    const dismissedV1Only = new Set(["v1"]);
    expect(isAnnouncementDismissedBySeries(v2, series, dismissedV1Only)).toBe(true);
    expect(isAnnouncementDismissedBySeries(v3, series, dismissedV1Only)).toBe(false);
    expect(isAnnouncementDismissedBySeries(v4, series, dismissedV1Only)).toBe(false);

    const dismissedV3 = new Set(["v3"]);
    expect(isAnnouncementDismissedBySeries(v4, series, dismissedV3)).toBe(true);
  });

  it("ignores soft-deleted rows as active candidates or replacements while keeping recorded dismissals on deleted earlier versions", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const v1Deleted = candidate({
      id: "v1",
      version: 1,
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const v2Active = candidate({
      id: "v2",
      seriesId: "v1",
      version: 2,
      dismissalFloorVersion: 1,
      startsAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    const v3Deleted = candidate({
      id: "v3",
      seriesId: "v1",
      version: 3,
      startsAt: new Date("2026-04-01T00:00:00.000Z"),
      deletedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const series = [v1Deleted, v2Active, v3Deleted];

    expect(isAnnouncementVersionActive(v1Deleted, series, now)).toBe(false);
    expect(findAnnouncementReplacement(v2Active, series, now)).toBeNull();
    expect(isAnnouncementVersionActive(v2Active, series, now)).toBe(true);
    expect(isAnnouncementDismissedBySeries(v2Active, series, new Set(["v1"]))).toBe(true);
  });
});
