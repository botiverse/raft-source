import type { Client } from "pg";

type AnnouncementLocale = "en" | "zh-cn";
type AnnouncementStatus = "draft" | "published" | "expired";
type EffectiveStatus = AnnouncementStatus | "scheduled";
type AuditAction =
  | "created"
  | "updated"
  | "published"
  | "scheduled"
  | "schedule_updated"
  | "schedule_cancelled"
  | "activated"
  | "expired";

type AnnouncementPage = { title?: string; body: string };
type AnnouncementContent = { title: string; pages: AnnouncementPage[] };
type AnnouncementContentByLocale = Partial<Record<AnnouncementLocale, AnnouncementContent>>;

type AnnouncementDraftInput = {
  defaultLocale: AnnouncementLocale;
  content: AnnouncementContentByLocale;
  startsAt: Date | null;
  endsAt: Date | null;
};

type AnnouncementRow = {
  id: string;
  title: string;
  pages: AnnouncementPage[];
  defaultLocale: AnnouncementLocale;
  localizedContent: AnnouncementContentByLocale;
  status: AnnouncementStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  publishedAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  publishedByUserId: string | null;
};

export type AdminAnnouncement = {
  id: string;
  defaultLocale: AnnouncementLocale;
  content: AnnouncementContentByLocale;
  status: AnnouncementStatus;
  effectiveStatus: EffectiveStatus;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  publishedByUserId: string | null;
};

// Announcement IDs come from PostgreSQL's uuid column. Historical rows may
// carry version/variant nibbles that RFC 4122 generators do not emit, so this
// route boundary validates the canonical 8-4-4-4-12 database representation
// without imposing generator-version semantics.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ROW_COLUMNS = `
  id,
  title,
  pages,
  default_locale,
  localized_content,
  status,
  starts_at,
  ends_at,
  published_at,
  activated_at,
  created_at,
  updated_at,
  created_by_user_id,
  updated_by_user_id,
  published_by_user_id
`;

class AnnouncementAdminError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function responseError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asPages(value: unknown): AnnouncementPage[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const page = entry as Record<string, unknown>;
    if (typeof page.body !== "string") return [];
    return [{
      body: page.body,
      ...(typeof page.title === "string" ? { title: page.title } : {}),
    }];
  });
}

function asDate(value: unknown, required = false): Date | null {
  if (value === null || value === undefined) {
    if (required) throw new Error("announcement row is missing a required timestamp");
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("announcement row contains an invalid timestamp");
  return parsed;
}

function asLocale(value: unknown): AnnouncementLocale {
  return value === "zh-cn" ? "zh-cn" : "en";
}

function asStatus(value: unknown): AnnouncementStatus {
  if (value === "draft" || value === "published" || value === "expired") return value;
  throw new Error("announcement row contains an invalid status");
}

function mapRow(raw: Record<string, unknown>): AnnouncementRow {
  const localized = asObject(raw.localized_content);
  const localizedContent: AnnouncementContentByLocale = {};
  for (const locale of ["en", "zh-cn"] as const) {
    const entry = asObject(localized[locale]);
    if (typeof entry.title !== "string") continue;
    localizedContent[locale] = { title: entry.title, pages: asPages(entry.pages) };
  }
  return {
    id: String(raw.id),
    title: String(raw.title),
    pages: asPages(raw.pages),
    defaultLocale: asLocale(raw.default_locale),
    localizedContent,
    status: asStatus(raw.status),
    startsAt: asDate(raw.starts_at),
    endsAt: asDate(raw.ends_at),
    publishedAt: asDate(raw.published_at),
    activatedAt: asDate(raw.activated_at),
    createdAt: asDate(raw.created_at, true) as Date,
    updatedAt: asDate(raw.updated_at, true) as Date,
    createdByUserId: raw.created_by_user_id == null ? null : String(raw.created_by_user_id),
    updatedByUserId: raw.updated_by_user_id == null ? null : String(raw.updated_by_user_id),
    publishedByUserId: raw.published_by_user_id == null ? null : String(raw.published_by_user_id),
  };
}

function storedContent(row: AnnouncementRow): AnnouncementContentByLocale {
  return {
    ...row.localizedContent,
    [row.defaultLocale]: { title: row.title, pages: row.pages },
  };
}

function effectiveStatus(row: AnnouncementRow, now: Date): EffectiveStatus {
  if (row.status !== "published") return row.status;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return "scheduled";
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return "expired";
  return "published";
}

function toAdminAnnouncement(row: AnnouncementRow, now: Date): AdminAnnouncement {
  return {
    id: row.id,
    defaultLocale: row.defaultLocale,
    content: storedContent(row),
    status: row.status,
    effectiveStatus: effectiveStatus(row, now),
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

function validateContentEntry(value: unknown): AnnouncementContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnnouncementAdminError(400, "each localized announcement must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.title !== "string" || entry.title.trim().length === 0 || entry.title.length > 200) {
    throw new AnnouncementAdminError(400, "each localized title must contain 1-200 characters");
  }
  if (!Array.isArray(entry.pages) || entry.pages.length === 0 || entry.pages.length > 20) {
    throw new AnnouncementAdminError(400, "each locale must contain 1-20 pages");
  }
  return {
    title: entry.title.trim(),
    pages: entry.pages.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AnnouncementAdminError(400, "each localized page must be an object");
      }
      const page = value as Record<string, unknown>;
      if (typeof page.body !== "string" || page.body.trim().length === 0 || page.body.length > 20_000) {
        throw new AnnouncementAdminError(400, "each localized page body must contain 1-20000 characters");
      }
      if (page.title !== undefined && (typeof page.title !== "string" || page.title.length > 200)) {
        throw new AnnouncementAdminError(400, "localized page titles must contain at most 200 characters");
      }
      return {
        body: page.body,
        ...(typeof page.title === "string" ? { title: page.title } : {}),
      };
    }),
  };
}

function parseOptionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AnnouncementAdminError(400, `${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AnnouncementAdminError(400, `${label} must be an ISO timestamp`);
  return parsed;
}

function parseDraftInput(value: unknown): AnnouncementDraftInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnnouncementAdminError(400, "announcement input must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.defaultLocale !== "en" && record.defaultLocale !== "zh-cn") {
    throw new AnnouncementAdminError(400, "defaultLocale must be en or zh-cn");
  }
  const rawContent = asObject(record.content);
  const unsupported = Object.keys(rawContent).find((locale) => locale !== "en" && locale !== "zh-cn");
  if (unsupported) throw new AnnouncementAdminError(400, `unsupported announcement locale: ${unsupported}`);
  const content: AnnouncementContentByLocale = {};
  for (const locale of ["en", "zh-cn"] as const) {
    if (rawContent[locale] !== undefined) content[locale] = validateContentEntry(rawContent[locale]);
  }
  const fallback = content[record.defaultLocale];
  if (!fallback) throw new AnnouncementAdminError(400, "content must include defaultLocale");
  for (const localized of Object.values(content)) {
    if (localized && localized.pages.length !== fallback.pages.length) {
      throw new AnnouncementAdminError(400, "all localized content must use the same page count and order");
    }
  }
  const startsAt = parseOptionalDate(record.startsAt, "startsAt");
  const endsAt = parseOptionalDate(record.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new AnnouncementAdminError(400, "endsAt must be later than startsAt");
  }
  return { defaultLocale: record.defaultLocale, content, startsAt, endsAt };
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AnnouncementAdminError(400, "request body must be valid JSON");
  }
}

async function rows(
  client: Client,
  text: string,
  values: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(text, values);
  return result.rows as Array<Record<string, unknown>>;
}

async function transaction<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function insertAudit(
  client: Client,
  announcementId: string,
  actorUserId: string | null,
  action: AuditAction,
  createdAt: Date,
): Promise<void> {
  await client.query(`
    INSERT INTO announcement_audit_events (
      id, announcement_id, actor_user_id, action, created_at
    ) VALUES ($1, $2, $3, $4, $5)
  `, [crypto.randomUUID(), announcementId, actorUserId, action, createdAt]);
}

async function activateIfDue(client: Client, announcementId: string, now: Date): Promise<void> {
  await transaction(client, async () => {
    const [activated] = await rows(client, `
      UPDATE announcements
      SET activated_at = starts_at
      WHERE id = $1
        AND status = 'published'
        AND starts_at <= $2
        AND activated_at IS NULL
      RETURNING id, starts_at
    `, [announcementId, now]);
    if (!activated) return;
    await insertAudit(client, announcementId, null, "activated", asDate(activated.starts_at) ?? now);
  });
}

function draftValues(input: AnnouncementDraftInput) {
  const fallback = input.content[input.defaultLocale];
  if (!fallback) throw new AnnouncementAdminError(400, "content must include defaultLocale");
  return {
    title: fallback.title,
    pages: fallback.pages,
    defaultLocale: input.defaultLocale,
    localizedContent: input.content,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };
}

function overlaps(
  firstStart: Date,
  firstEnd: Date | null,
  secondStart: Date,
  secondEnd: Date | null,
): boolean {
  return firstStart.getTime() < (secondEnd?.getTime() ?? Number.POSITIVE_INFINITY)
    && secondStart.getTime() < (firstEnd?.getTime() ?? Number.POSITIVE_INFINITY);
}

async function publishedWindows(client: Client, excludeId?: string): Promise<AnnouncementRow[]> {
  const values: unknown[] = [];
  const exclusion = excludeId ? "AND id <> $1" : "";
  if (excludeId) values.push(excludeId);
  return (await rows(client, `
    SELECT ${ADMIN_ROW_COLUMNS}
    FROM announcements
    WHERE status = 'published' ${exclusion}
    FOR SHARE
  `, values)).map(mapRow);
}

function assertNoOverlap(
  windows: AnnouncementRow[],
  startsAt: Date,
  endsAt: Date | null,
): void {
  const conflict = windows.find((row) => row.startsAt && overlaps(startsAt, endsAt, row.startsAt, row.endsAt));
  if (conflict) {
    throw new AnnouncementAdminError(400, `announcement window overlaps published announcement ${conflict.id}`);
  }
}

async function listAnnouncements(client: Client, now: Date): Promise<AdminAnnouncement[]> {
  const due = await rows(client, `
    SELECT id
    FROM announcements
    WHERE status = 'published' AND starts_at <= $1 AND activated_at IS NULL
  `, [now]);
  for (const row of due) await activateIfDue(client, String(row.id), now);
  const result = await rows(client, `
    SELECT ${ADMIN_ROW_COLUMNS}
    FROM announcements
    ORDER BY created_at DESC
  `);
  return result.map(mapRow).map((row) => toAdminAnnouncement(row, now));
}

async function createDraft(
  client: Client,
  actorUserId: string,
  input: AnnouncementDraftInput,
  now: Date,
): Promise<AdminAnnouncement> {
  const value = draftValues(input);
  return transaction(client, async () => {
    const id = crypto.randomUUID();
    const [created] = await rows(client, `
      INSERT INTO announcements (
        id, title, pages, default_locale, localized_content, status,
        starts_at, ends_at, published_at, activated_at,
        created_by_user_id, updated_by_user_id, published_by_user_id,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3::json, $4, $5::json, 'draft',
        $6, $7, NULL, NULL,
        $8, $8, NULL,
        $9, $9
      )
      RETURNING ${ADMIN_ROW_COLUMNS}
    `, [
      id,
      value.title,
      JSON.stringify(value.pages),
      value.defaultLocale,
      JSON.stringify(value.localizedContent),
      value.startsAt,
      value.endsAt,
      actorUserId,
      now,
    ]);
    if (!created) throw new Error("announcement insert returned no row");
    await insertAudit(client, id, actorUserId, "created", now);
    return toAdminAnnouncement(mapRow(created), now);
  });
}

async function updateDraft(
  client: Client,
  actorUserId: string,
  announcementId: string,
  input: AnnouncementDraftInput,
  now: Date,
): Promise<AdminAnnouncement> {
  const value = draftValues(input);
  return transaction(client, async () => {
    const [raw] = await rows(client, `
      SELECT ${ADMIN_ROW_COLUMNS}
      FROM announcements
      WHERE id = $1
      FOR UPDATE
    `, [announcementId]);
    if (!raw) throw new AnnouncementAdminError(409, "Only drafts or not-yet-active scheduled announcements can be edited");
    const existing = mapRow(raw);
    let action: AuditAction;
    if (existing.status === "published" && existing.startsAt && existing.startsAt.getTime() > now.getTime()) {
      if (!value.startsAt || value.startsAt.getTime() <= now.getTime()) {
        throw new AnnouncementAdminError(400, "a scheduled announcement update must keep startsAt in the future");
      }
      assertNoOverlap(await publishedWindows(client, announcementId), value.startsAt, value.endsAt);
      action = "schedule_updated";
    } else if (existing.status === "draft") {
      action = "updated";
    } else {
      throw new AnnouncementAdminError(409, "Only drafts or not-yet-active scheduled announcements can be edited");
    }
    const [updated] = await rows(client, `
      UPDATE announcements
      SET title = $2,
          pages = $3::json,
          default_locale = $4,
          localized_content = $5::json,
          starts_at = $6,
          ends_at = $7,
          updated_by_user_id = $8,
          updated_at = $9
      WHERE id = $1
      RETURNING ${ADMIN_ROW_COLUMNS}
    `, [
      announcementId,
      value.title,
      JSON.stringify(value.pages),
      value.defaultLocale,
      JSON.stringify(value.localizedContent),
      value.startsAt,
      value.endsAt,
      actorUserId,
      now,
    ]);
    if (!updated) throw new Error("announcement update returned no row");
    await insertAudit(client, announcementId, actorUserId, action, now);
    return toAdminAnnouncement(mapRow(updated), now);
  });
}

async function publishDraft(
  client: Client,
  actorUserId: string,
  announcementId: string,
  now: Date,
): Promise<AdminAnnouncement> {
  return transaction(client, async () => {
    const [raw] = await rows(client, `
      SELECT ${ADMIN_ROW_COLUMNS}
      FROM announcements
      WHERE id = $1 AND status = 'draft'
      FOR UPDATE
    `, [announcementId]);
    if (!raw) throw new AnnouncementAdminError(409, "Only existing drafts can be published");
    const draft = mapRow(raw);
    const startsAt = draft.startsAt ?? now;
    if (draft.endsAt && draft.endsAt.getTime() <= now.getTime()) {
      throw new AnnouncementAdminError(400, "endsAt must be in the future when publishing");
    }
    assertNoOverlap(await publishedWindows(client), startsAt, draft.endsAt);
    const [published] = await rows(client, `
      UPDATE announcements
      SET status = 'published',
          starts_at = $2::timestamptz,
          published_at = $3::timestamptz,
          activated_at = CASE
            WHEN $2::timestamptz <= $3::timestamptz THEN $3::timestamptz
            ELSE NULL
          END,
          published_by_user_id = $4,
          updated_by_user_id = $4,
          updated_at = $3::timestamptz
      WHERE id = $1 AND status = 'draft'
      RETURNING ${ADMIN_ROW_COLUMNS}
    `, [announcementId, startsAt, now, actorUserId]);
    if (!published) throw new AnnouncementAdminError(409, "Only existing drafts can be published");
    if (startsAt.getTime() > now.getTime()) {
      await insertAudit(client, announcementId, actorUserId, "scheduled", now);
    } else {
      await insertAudit(client, announcementId, actorUserId, "published", now);
      await insertAudit(client, announcementId, null, "activated", new Date(now.getTime() + 1));
    }
    return toAdminAnnouncement(mapRow(published), now);
  });
}

async function cancelScheduled(
  client: Client,
  actorUserId: string,
  announcementId: string,
  now: Date,
): Promise<AdminAnnouncement> {
  return transaction(client, async () => {
    const [raw] = await rows(client, `
      SELECT ${ADMIN_ROW_COLUMNS}
      FROM announcements
      WHERE id = $1 AND status = 'published'
      FOR UPDATE
    `, [announcementId]);
    const existing = raw ? mapRow(raw) : null;
    if (!existing?.startsAt || existing.startsAt.getTime() <= now.getTime()) {
      throw new AnnouncementAdminError(409, "Only not-yet-active scheduled announcements can be cancelled");
    }
    const [cancelled] = await rows(client, `
      UPDATE announcements
      SET status = 'draft',
          published_at = NULL,
          published_by_user_id = NULL,
          activated_at = NULL,
          updated_by_user_id = $2,
          updated_at = $3
      WHERE id = $1 AND status = 'published'
      RETURNING ${ADMIN_ROW_COLUMNS}
    `, [announcementId, actorUserId, now]);
    if (!cancelled) throw new AnnouncementAdminError(409, "Only not-yet-active scheduled announcements can be cancelled");
    await insertAudit(client, announcementId, actorUserId, "schedule_cancelled", now);
    return toAdminAnnouncement(mapRow(cancelled), now);
  });
}

async function expireAnnouncement(
  client: Client,
  actorUserId: string,
  announcementId: string,
  now: Date,
): Promise<AdminAnnouncement> {
  return transaction(client, async () => {
    const [expired] = await rows(client, `
      UPDATE announcements
      SET status = 'expired',
          ends_at = $2,
          updated_by_user_id = $3,
          updated_at = $2
      WHERE id = $1
        AND status = 'published'
        AND starts_at <= $2
      RETURNING ${ADMIN_ROW_COLUMNS}
    `, [announcementId, now, actorUserId]);
    if (!expired) throw new AnnouncementAdminError(409, "Only active published announcements can be expired");
    await insertAudit(client, announcementId, actorUserId, "expired", now);
    return toAdminAnnouncement(mapRow(expired), now);
  });
}

async function listAudit(client: Client, announcementId: string, now: Date) {
  await activateIfDue(client, announcementId, now);
  const result = await rows(client, `
    SELECT id, announcement_id, actor_user_id, action, created_at
    FROM announcement_audit_events
    WHERE announcement_id = $1
    ORDER BY created_at DESC
  `, [announcementId]);
  return result.map((row) => ({
    id: String(row.id),
    announcementId: String(row.announcement_id),
    actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
    action: String(row.action),
    createdAt: (asDate(row.created_at, true) as Date).toISOString(),
  }));
}

function routeId(raw: string | undefined): string {
  let id: string;
  try {
    id = decodeURIComponent(raw ?? "");
  } catch {
    throw new AnnouncementAdminError(400, "announcement id must be a valid UUID");
  }
  if (!UUID_RE.test(id)) throw new AnnouncementAdminError(400, "announcement id must be a valid UUID");
  return id;
}

async function dispatch(
  request: Request,
  actorUserId: string,
  client: Client,
  now: Date,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/operator/announcements") {
    if (request.method === "GET") {
      return Response.json({ announcements: await listAnnouncements(client, now) });
    }
    if (request.method === "POST") {
      const announcement = await createDraft(client, actorUserId, parseDraftInput(await requestJson(request)), now);
      return Response.json({ announcement }, { status: 201 });
    }
  }

  const auditMatch = path.match(/^\/api\/operator\/announcements\/([^/]+)\/audit$/);
  if (request.method === "GET" && auditMatch) {
    return Response.json({ events: await listAudit(client, routeId(auditMatch[1]), now) });
  }

  const actionMatch = path.match(/^\/api\/operator\/announcements\/([^/]+)\/(publish|expire|cancel)$/);
  if (request.method === "POST" && actionMatch) {
    const id = routeId(actionMatch[1]);
    const action = actionMatch[2];
    const announcement = action === "publish"
      ? await publishDraft(client, actorUserId, id, now)
      : action === "expire"
        ? await expireAnnouncement(client, actorUserId, id, now)
        : await cancelScheduled(client, actorUserId, id, now);
    return Response.json({ announcement });
  }

  const editMatch = path.match(/^\/api\/operator\/announcements\/([^/]+)$/);
  if (request.method === "PATCH" && editMatch) {
    const announcement = await updateDraft(
      client,
      actorUserId,
      routeId(editMatch[1]),
      parseDraftInput(await requestJson(request)),
      now,
    );
    return Response.json({ announcement });
  }

  return responseError("Unknown announcement admin route", 404);
}

export async function handleAnnouncementAdminRequest(
  request: Request,
  actorUserId: string,
  client: Client,
  now = new Date(),
): Promise<Response> {
  try {
    return await dispatch(request, actorUserId, client, now);
  } catch (error) {
    if (error instanceof AnnouncementAdminError) return responseError(error.message, error.status);
    console.error("[announcement-admin]", error instanceof Error ? error.message : "unknown");
    return responseError("Announcement admin operation failed", 500);
  }
}
