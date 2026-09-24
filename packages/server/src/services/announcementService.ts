import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  currentDate,
  DISPLAY_LOCALES,
  normalizeDisplayLocale,
  type Announcement,
  type AnnouncementContent,
  type AnnouncementContentByLocale,
  type AnnouncementPage,
  type DisplayLocale,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  announcementAuditEvents,
  announcements,
  userAnnouncementDismissals,
  users,
} from "../db/schema.js";

export type {
  Announcement,
  AnnouncementContent,
  AnnouncementContentByLocale,
  AnnouncementPage,
  DisplayLocale,
};

export type AnnouncementStatus = "draft" | "published" | "expired";
export type AnnouncementEffectiveStatus = AnnouncementStatus | "scheduled";
export type AnnouncementAuditAction =
  | "created"
  | "updated"
  | "published"
  | "scheduled"
  | "schedule_updated"
  | "schedule_cancelled"
  | "activated"
  | "expired";

export interface AnnouncementDraftInput {
  defaultLocale: DisplayLocale;
  content: AnnouncementContentByLocale;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export interface AdminAnnouncement {
  id: string;
  defaultLocale: DisplayLocale;
  content: AnnouncementContentByLocale;
  status: AnnouncementStatus;
  effectiveStatus: AnnouncementEffectiveStatus;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  publishedByUserId: string | null;
}

type AnnouncementRow = typeof announcements.$inferSelect;

function validateContentEntry(content: AnnouncementContent): AnnouncementContent {
  if (
    typeof content.title !== "string"
    || content.title.trim().length === 0
    || content.title.length > 200
  ) {
    throw new Error("each localized title must contain 1-200 characters");
  }
  if (!Array.isArray(content.pages) || content.pages.length === 0 || content.pages.length > 20) {
    throw new Error("each locale must contain 1-20 pages");
  }
  return {
    title: content.title.trim(),
    pages: content.pages.map((page) => {
      if (
        typeof page.body !== "string"
        || page.body.trim().length === 0
        || page.body.length > 20_000
      ) {
        throw new Error("each localized page body must contain 1-20000 characters");
      }
      if (
        page.title !== undefined
        && (typeof page.title !== "string" || page.title.length > 200)
      ) {
        throw new Error("localized page titles must contain at most 200 characters");
      }
      return {
        body: page.body,
        ...(page.title === undefined ? {} : { title: page.title }),
      };
    }),
  };
}

export function validateLocalizedContent(
  defaultLocale: DisplayLocale,
  rawContent: AnnouncementContentByLocale,
): AnnouncementContentByLocale {
  if (!DISPLAY_LOCALES.includes(defaultLocale)) {
    throw new Error("defaultLocale must be en or zh-cn");
  }
  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    throw new Error("content must be an object keyed by locale");
  }

  const unsupportedLocales = Object.keys(rawContent)
    .filter((locale) => !DISPLAY_LOCALES.includes(locale as DisplayLocale));
  if (unsupportedLocales.length > 0) {
    throw new Error(`unsupported announcement locale: ${unsupportedLocales[0]}`);
  }

  const content: AnnouncementContentByLocale = {};
  for (const locale of DISPLAY_LOCALES) {
    const entry = rawContent[locale];
    if (entry !== undefined) content[locale] = validateContentEntry(entry);
  }
  const fallback = content[defaultLocale];
  if (!fallback) {
    throw new Error("content must include defaultLocale");
  }
  const pageCount = fallback.pages.length;
  for (const locale of DISPLAY_LOCALES) {
    const entry = content[locale];
    if (entry && entry.pages.length !== pageCount) {
      throw new Error("all localized content must use the same page count and order");
    }
  }
  return content;
}

function validateWindow(startsAt: Date | null | undefined, endsAt: Date | null | undefined): void {
  if (startsAt && Number.isNaN(startsAt.getTime())) throw new Error("startsAt must be a valid date");
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new Error("endsAt must be a valid date");
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new Error("endsAt must be later than startsAt");
  }
}

function storedContent(row: AnnouncementRow): AnnouncementContentByLocale {
  const content: AnnouncementContentByLocale = { ...row.localizedContent };
  content[row.defaultLocale] = {
    title: row.title,
    pages: row.pages,
  };
  return content;
}

export function resolveAnnouncementContent(
  row: Pick<AnnouncementRow, "title" | "pages" | "defaultLocale" | "localizedContent">,
  preferredLocale?: string | null,
): { locale: DisplayLocale; content: AnnouncementContent } {
  const content = storedContent(row as AnnouncementRow);
  const normalized = normalizeDisplayLocale(preferredLocale);
  const locale = normalized && content[normalized] ? normalized : row.defaultLocale;
  const resolved = content[locale] ?? content[row.defaultLocale];
  if (!resolved) {
    // Rows created before localized content was introduced always retain their
    // default title/pages columns, so this branch is a defensive fallback only.
    return { locale: row.defaultLocale, content: { title: row.title, pages: row.pages } };
  }
  return { locale, content: resolved };
}

function toAnnouncement(row: AnnouncementRow, preferredLocale?: string | null): Announcement {
  const { locale, content } = resolveAnnouncementContent(row, preferredLocale);
  const startsAt = row.startsAt ?? row.publishedAt ?? row.createdAt;
  return {
    id: row.id,
    title: content.title,
    pages: content.pages,
    publishedAt: (row.publishedAt ?? startsAt).toISOString(),
    startsAt: startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    locale,
  };
}

export function effectiveAnnouncementStatus(
  row: Pick<AnnouncementRow, "status" | "startsAt" | "endsAt">,
  now = currentDate(),
): AnnouncementEffectiveStatus {
  if (row.status !== "published") return row.status;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return "scheduled";
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return "expired";
  return "published";
}

function toAdminAnnouncement(row: AnnouncementRow, now = currentDate()): AdminAnnouncement {
  return {
    id: row.id,
    defaultLocale: row.defaultLocale,
    content: storedContent(row),
    status: row.status,
    effectiveStatus: effectiveAnnouncementStatus(row, now),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    publishedByUserId: row.publishedByUserId,
  };
}

function normalizedDraftValues(input: AnnouncementDraftInput) {
  const content = validateLocalizedContent(input.defaultLocale, input.content);
  validateWindow(input.startsAt, input.endsAt);
  const fallback = content[input.defaultLocale];
  if (!fallback) throw new Error("content must include defaultLocale");
  return {
    title: fallback.title,
    pages: fallback.pages,
    defaultLocale: input.defaultLocale,
    localizedContent: content,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  };
}

function windowsOverlap(
  firstStart: Date,
  firstEnd: Date | null,
  secondStart: Date,
  secondEnd: Date | null,
): boolean {
  const firstEndMs = firstEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  const secondEndMs = secondEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  return firstStart.getTime() < secondEndMs && secondStart.getTime() < firstEndMs;
}

async function recordActivationIfNeeded(
  announcementId: string,
  now = currentDate(),
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [activated] = await tx
      .update(announcements)
      .set({ activatedAt: sql`${announcements.startsAt}` })
      .where(and(
        eq(announcements.id, announcementId),
        eq(announcements.status, "published"),
        lte(announcements.startsAt, now),
        isNull(announcements.activatedAt),
      ))
      .returning({
        id: announcements.id,
        startsAt: announcements.startsAt,
      });
    if (!activated) return;
    await tx.insert(announcementAuditEvents).values({
      announcementId,
      actorUserId: null,
      action: "activated",
      createdAt: activated.startsAt ?? now,
    });
  });
}

/**
 * A newly onboarded account is not eligible in the auth session family that
 * completed its first final handoff. Refresh/token rotation keeps the family,
 * while a fresh login creates a new one. Missing-family legacy tokens fail
 * closed until the next family-bearing login.
 */
/**
 * REMOVED 2026-08-07: `isEligibleAfterOnboarding`.
 *
 * It gated announcements on an ACCOUNT-GLOBAL fact (`users.firstOnboardingCompletedAt`
 * plus the login family that first completed onboarding), while the onboarding surface
 * it was protecting is PER-SERVER (`serverMembers.setupHandoffAcknowledgedAt`). The
 * mismatch is why it read like a broken check.
 *
 * The client already suppresses announcements per-server while that server's setup is
 * incomplete (`onboardingAnnouncementGateStore` <- `ServerSetupProjectionGate`), so the
 * only case this function uniquely covered was: "same login session, onboarding dialog
 * just closed". @cindyz decided on 2026-08-07 to move that to the client too, explicitly
 * accepting that the client's in-memory memory is lost on refresh -- i.e. finishing
 * onboarding and reloading may now show an announcement.
 *
 * ⚠️ It also deliberately overturns a fail-closed choice @John made on 2026-07-29 when
 * writing migration 0209 ("未完成用户保持 null / fail closed", `#wg-announcement:cae212f5`
 * msg c65a874b): users with neither a handoff ack nor `profile_setup_completed_at` were
 * left null on purpose so they would never receive announcements. Those users are now
 * governed by the per-server client gate alone. This is a product decision, not cleanup
 * of an oversight -- do not "restore" it from that record.
 */
/**
 * Returns at most one announcement: the OLDEST still-live row this user has not
 * finished reading or explicitly skipped for this request. A future scheduled
 * row does not hide a currently active one.
 *
 * ⚠️ THIS DELIBERATELY REPLACES AN EARLIER INVARIANT — do not "restore" it.
 * Until 2026-08-07 this function took only the NEWEST started row and returned
 * nothing if that row was expired/ended/dismissed. `"expired"` sat in the WHERE
 * clause on purpose so an expired newest row would still win the ordering and
 * then suppress everything behind it, guaranteeing that "dismissal, manual
 * expiry, or natural end never resurrects an older campaign".
 *
 * @cindyz decided on 2026-08-07 that a user should instead work through every
 * live announcement they have not read, oldest first, so an older unread row now
 * DOES surface after a newer one. That is the intended product behaviour, not a
 * regression. (A `priority` column may later join the ordering; not implemented.)
 *
 * Dismissal participates in SELECTION rather than being checked afterwards: a
 * post-check would make "the oldest row is already read" collapse to "no
 * announcement", which is the old defect facing the other way.
 */
export async function listUndismissedForUser(
  userId: string,
  sessionFamilyId?: string,
  now = currentDate(),
  afterAnnouncementId?: string,
): Promise<Announcement[]> {
  const db = getDb();
  const [user] = await db
    .select({ displayLanguage: users.displayLanguage })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return [];

  // Failed read-complete writes form a monotonic prefix of this stable queue:
  // the client can only fail the row it just received, then asks for the next
  // row. A single request-only frontier therefore represents an arbitrarily
  // long session without an ever-growing UUID list or a transport cap. It is
  // not a dismissal and is never persisted; a fresh session omits it and sees
  // the server-authoritative oldest unread row again.
  const [afterRow] = afterAnnouncementId
    ? await db
        .select({
          id: announcements.id,
          startsAt: announcements.startsAt,
          publishedAt: announcements.publishedAt,
          createdAt: announcements.createdAt,
        })
        .from(announcements)
        .where(eq(announcements.id, afterAnnouncementId))
        .limit(1)
    : [];
  if (afterAnnouncementId && (!afterRow || !afterRow.startsAt)) return [];
  const afterPublishedAt = afterRow
    ? afterRow.publishedAt ?? afterRow.startsAt ?? afterRow.createdAt
    : undefined;
  const publishedOrder = sql<Date>`coalesce(${announcements.publishedAt}, ${announcements.startsAt}, ${announcements.createdAt})`;
  const afterCondition = afterRow && afterPublishedAt
    ? or(
        gt(announcements.startsAt, afterRow.startsAt!),
        and(
          eq(announcements.startsAt, afterRow.startsAt!),
          gt(publishedOrder, afterPublishedAt),
        ),
        and(
          eq(announcements.startsAt, afterRow.startsAt!),
          eq(publishedOrder, afterPublishedAt),
          gt(announcements.createdAt, afterRow.createdAt),
        ),
        and(
          eq(announcements.startsAt, afterRow.startsAt!),
          eq(publishedOrder, afterPublishedAt),
          eq(announcements.createdAt, afterRow.createdAt),
          gt(announcements.id, afterRow.id),
        ),
      )
    : undefined;

  const [oldestUnread] = await db
    .select({ announcement: announcements })
    .from(announcements)
    // The user-id predicate belongs in the JOIN condition, never in WHERE: in
    // WHERE it turns this LEFT JOIN into an inner join and filters out exactly
    // the un-dismissed rows we are looking for.
    .leftJoin(
      userAnnouncementDismissals,
      and(
        eq(userAnnouncementDismissals.announcementId, announcements.id),
        eq(userAnnouncementDismissals.userId, userId),
      ),
    )
    .where(and(
      eq(announcements.status, "published"),
      lte(announcements.startsAt, now),
      or(isNull(announcements.endsAt), gt(announcements.endsAt, now)),
      isNull(userAnnouncementDismissals.userId),
      afterCondition,
    ))
    .orderBy(
      asc(announcements.startsAt),
      asc(publishedOrder),
      asc(announcements.createdAt),
      asc(announcements.id),
    )
    .limit(1);

  const row = oldestUnread?.announcement;
  if (!row) return [];
  await recordActivationIfNeeded(row.id, now);
  return [toAnnouncement(row, user.displayLanguage)];
}

export async function dismiss(
  userId: string,
  announcementId: string,
  now = currentDate(),
): Promise<boolean> {
  const db = getDb();
  const [exists] = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(and(
      eq(announcements.id, announcementId),
      eq(announcements.status, "published"),
      lte(announcements.startsAt, now),
      or(isNull(announcements.endsAt), gt(announcements.endsAt, now)),
    ))
    .limit(1);
  if (!exists) return false;
  await db
    .insert(userAnnouncementDismissals)
    .values({ userId, announcementId })
    .onConflictDoNothing();
  return true;
}

/**
 * Compatibility helper for trusted server-side fixtures. Operator callers use
 * createDraft + publishDraft so actor/audit state stays explicit.
 */
export async function publish(
  params: {
    title: string;
    pages: AnnouncementPage[];
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<Announcement> {
  const now = currentDate();
  const content = validateLocalizedContent("en", {
    en: { title: params.title, pages: params.pages },
  });
  validateWindow(params.startsAt, params.endsAt);
  const db = getDb();
  const [row] = await db
    .insert(announcements)
    .values({
      title: content.en?.title ?? params.title,
      pages: content.en?.pages ?? params.pages,
      defaultLocale: "en",
      localizedContent: content,
      status: "published",
      startsAt: params.startsAt ?? now,
      endsAt: params.endsAt ?? null,
      publishedAt: now,
    })
    .returning();
  return toAnnouncement(row, "en");
}

export async function createDraft(
  actorUserId: string,
  input: AnnouncementDraftInput,
): Promise<AdminAnnouncement> {
  const values = normalizedDraftValues(input);
  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(announcements)
      .values({
        ...values,
        status: "draft",
        publishedAt: null,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .returning();
    await tx.insert(announcementAuditEvents).values({
      announcementId: row.id,
      actorUserId,
      action: "created",
    });
    return toAdminAnnouncement(row);
  });
}

export async function updateDraft(
  actorUserId: string,
  announcementId: string,
  input: AnnouncementDraftInput,
): Promise<AdminAnnouncement | null> {
  const values = normalizedDraftValues(input);
  const db = getDb();
  const now = currentDate();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(announcements)
      .where(eq(announcements.id, announcementId))
      .limit(1);
    if (!existing) return null;

    if (existing.status === "published" && existing.startsAt && existing.startsAt.getTime() > now.getTime()) {
      if (!values.startsAt || values.startsAt.getTime() <= now.getTime()) {
        throw new Error("a scheduled announcement update must keep startsAt in the future");
      }
      const publishedRows = await tx
        .select({
          id: announcements.id,
          startsAt: announcements.startsAt,
          endsAt: announcements.endsAt,
        })
        .from(announcements)
        .where(and(
          eq(announcements.status, "published"),
          ne(announcements.id, announcementId),
        ));
      const conflict = publishedRows.find((row) => (
        row.startsAt
        && windowsOverlap(values.startsAt as Date, values.endsAt, row.startsAt, row.endsAt)
      ));
      if (conflict) {
        throw new Error(`announcement window overlaps published announcement ${conflict.id}`);
      }
      const [row] = await tx
        .update(announcements)
        .set({
          ...values,
          updatedByUserId: actorUserId,
          updatedAt: now,
        })
        .where(and(
          eq(announcements.id, announcementId),
          eq(announcements.status, "published"),
        ))
        .returning();
      if (!row) return null;
      await tx.insert(announcementAuditEvents).values({
        announcementId,
        actorUserId,
        action: "schedule_updated",
      });
      return toAdminAnnouncement(row, now);
    }

    if (existing.status !== "draft") return null;
    const [row] = await tx
      .update(announcements)
      .set({
        ...values,
        updatedByUserId: actorUserId,
        updatedAt: now,
      })
      .where(and(eq(announcements.id, announcementId), eq(announcements.status, "draft")))
      .returning();
    if (!row) return null;
    await tx.insert(announcementAuditEvents).values({
      announcementId,
      actorUserId,
      action: "updated",
    });
    return toAdminAnnouncement(row);
  }, { isolationLevel: "serializable" });
}

export async function publishDraft(
  actorUserId: string,
  announcementId: string,
  now = currentDate(),
): Promise<AdminAnnouncement | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(announcements)
      .where(and(eq(announcements.id, announcementId), eq(announcements.status, "draft")))
      .limit(1);
    if (!draft) return null;

    const startsAt = draft.startsAt ?? now;
    validateWindow(startsAt, draft.endsAt);
    if (draft.endsAt && draft.endsAt.getTime() <= now.getTime()) {
      throw new Error("endsAt must be in the future when publishing");
    }

    const publishedRows = await tx
      .select({
        id: announcements.id,
        startsAt: announcements.startsAt,
        endsAt: announcements.endsAt,
      })
      .from(announcements)
      .where(eq(announcements.status, "published"));
    const conflict = publishedRows.find((row) => (
      row.startsAt
      && windowsOverlap(startsAt, draft.endsAt, row.startsAt, row.endsAt)
    ));
    if (conflict) {
      throw new Error(`announcement window overlaps published announcement ${conflict.id}`);
    }

    const [row] = await tx
      .update(announcements)
      .set({
        status: "published",
        startsAt,
        publishedAt: now,
        activatedAt: startsAt.getTime() <= now.getTime() ? now : null,
        publishedByUserId: actorUserId,
        updatedByUserId: actorUserId,
        updatedAt: now,
      })
      .where(and(eq(announcements.id, announcementId), eq(announcements.status, "draft")))
      .returning();
    if (!row) return null;
    if (startsAt.getTime() > now.getTime()) {
      await tx.insert(announcementAuditEvents).values({
        announcementId,
        actorUserId,
        action: "scheduled",
      });
    } else {
      await tx.insert(announcementAuditEvents).values([
        { announcementId, actorUserId, action: "published", createdAt: now },
        {
          announcementId,
          actorUserId: null,
          action: "activated",
          createdAt: new Date(now.getTime() + 1),
        },
      ]);
    }
    return toAdminAnnouncement(row, now);
  }, { isolationLevel: "serializable" });
}

export async function cancelScheduledAnnouncement(
  actorUserId: string,
  announcementId: string,
  now = currentDate(),
): Promise<AdminAnnouncement | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(announcements)
      .where(and(
        eq(announcements.id, announcementId),
        eq(announcements.status, "published"),
      ))
      .limit(1);
    if (!existing?.startsAt || existing.startsAt.getTime() <= now.getTime()) return null;

    const [row] = await tx
      .update(announcements)
      .set({
        status: "draft",
        publishedAt: null,
        publishedByUserId: null,
        activatedAt: null,
        updatedByUserId: actorUserId,
        updatedAt: now,
      })
      .where(and(
        eq(announcements.id, announcementId),
        eq(announcements.status, "published"),
      ))
      .returning();
    if (!row) return null;
    await tx.insert(announcementAuditEvents).values({
      announcementId,
      actorUserId,
      action: "schedule_cancelled",
    });
    return toAdminAnnouncement(row, now);
  }, { isolationLevel: "serializable" });
}

export async function expireAnnouncement(
  actorUserId: string,
  announcementId: string,
  now = currentDate(),
): Promise<AdminAnnouncement | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(announcements)
      .set({
        status: "expired",
        endsAt: now,
        updatedByUserId: actorUserId,
        updatedAt: now,
      })
      .where(and(
        eq(announcements.id, announcementId),
        eq(announcements.status, "published"),
        lte(announcements.startsAt, now),
      ))
      .returning();
    if (!row) return null;
    await tx.insert(announcementAuditEvents).values({
      announcementId,
      actorUserId,
      action: "expired",
    });
    return toAdminAnnouncement(row, now);
  });
}

export async function listAdminAnnouncements(now = currentDate()): Promise<AdminAnnouncement[]> {
  const db = getDb();
  const dueRows = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(and(
      eq(announcements.status, "published"),
      lte(announcements.startsAt, now),
      isNull(announcements.activatedAt),
    ));
  await Promise.all(dueRows.map((row) => recordActivationIfNeeded(row.id, now)));
  const rows = await db
    .select()
    .from(announcements)
    .orderBy(desc(announcements.createdAt));
  return rows.map((row) => toAdminAnnouncement(row, now));
}

export async function listAuditEvents(announcementId: string): Promise<Array<{
  id: string;
  announcementId: string;
  actorUserId: string | null;
  action: AnnouncementAuditAction;
  createdAt: string;
}>> {
  await recordActivationIfNeeded(announcementId);
  const db = getDb();
  const rows = await db
    .select()
    .from(announcementAuditEvents)
    .where(eq(announcementAuditEvents.announcementId, announcementId))
    .orderBy(desc(announcementAuditEvents.createdAt));
  return rows.map((row) => ({
    id: row.id,
    announcementId: row.announcementId,
    actorUserId: row.actorUserId,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getById(
  id: string,
  preferredLocale?: string | null,
  now = currentDate(),
): Promise<Announcement | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(announcements)
    .where(and(
      eq(announcements.id, id),
      eq(announcements.status, "published"),
      lte(announcements.startsAt, now),
    ))
    .limit(1);
  if (!row || (row.endsAt && row.endsAt.getTime() <= now.getTime())) return null;
  return toAnnouncement(row, preferredLocale);
}

export async function getLatest(
  preferredLocale?: string | null,
  now = currentDate(),
): Promise<Announcement | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(announcements)
    .where(and(
      eq(announcements.status, "published"),
      lte(announcements.startsAt, now),
    ))
    .orderBy(desc(announcements.startsAt), desc(announcements.publishedAt))
    .limit(1);
  if (!row || (row.endsAt && row.endsAt.getTime() <= now.getTime())) return null;
  return toAnnouncement(row, preferredLocale);
}
