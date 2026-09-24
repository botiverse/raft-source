// Right-cause gate for the announcement publish SQL. Hosted runs this against
// PostgreSQL 16; ordinary package tests skip when no real-PG URL is supplied.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { handleAnnouncementAdminRequest } from "./announcementAdmin";

const REAL_PG_URL_ENV = "FEATURE_FLAG_ADMIN_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.FEATURE_FLAG_ADMIN_REAL_PG_REQUIRED === "1";
const skip = REAL_PG_URL || REAL_PG_REQUIRED
  ? false
  : `${REAL_PG_URL_ENV} is required for the opt-in real-PostgreSQL gate`;

const ACTOR = "22222222-2222-4222-8222-222222222222";
const IMMEDIATE_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULED_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-28T02:57:00.000Z");

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function publishRequest(id: string): Request {
  return new Request(`https://flags.test/api/operator/announcements/${id}/publish`, {
    method: "POST",
  });
}

test("publish types timestamp parameters and preserves immediate versus scheduled lifecycle", { skip }, async () => {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} must be set when the gate is required`);
  const databaseName = `ff_admin_announcement_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL });
  await admin.connect();
  const serverVersion = Number((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num ?? 0);
  assert.equal(Math.floor(serverVersion / 10_000), 16, "the publish receipt is pinned to PostgreSQL 16");
  await admin.query(`CREATE DATABASE ${databaseName}`);

  const client = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName) });
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE announcements (
        id uuid PRIMARY KEY,
        title text NOT NULL,
        pages json NOT NULL,
        default_locale text NOT NULL,
        localized_content json NOT NULL,
        status text NOT NULL,
        starts_at timestamptz,
        ends_at timestamptz,
        published_at timestamptz,
        activated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        created_by_user_id uuid,
        updated_by_user_id uuid,
        published_by_user_id uuid
      );
      CREATE TABLE announcement_audit_events (
        id uuid PRIMARY KEY,
        announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        actor_user_id uuid,
        action text NOT NULL,
        created_at timestamptz NOT NULL
      );
    `);

    const immediateEnd = new Date(NOW.getTime() + 60 * 60 * 1_000);
    const scheduledStart = new Date(NOW.getTime() + 2 * 60 * 60 * 1_000);
    const scheduledEnd = new Date(NOW.getTime() + 3 * 60 * 60 * 1_000);
    const pages = JSON.stringify([{ body: "World" }]);
    const localizedContent = JSON.stringify({ en: { title: "Hello", pages: [{ body: "World" }] } });
    await client.query(`
      INSERT INTO announcements (
        id, title, pages, default_locale, localized_content, status,
        starts_at, ends_at, created_by_user_id, updated_by_user_id
      ) VALUES
        ($1, 'Immediate', $3::json, 'en', $4::json, 'draft', NULL, $5, $2, $2),
        ($6, 'Scheduled', $3::json, 'en', $4::json, 'draft', $7, $8, $2, $2)
    `, [IMMEDIATE_ID, ACTOR, pages, localizedContent, immediateEnd, SCHEDULED_ID, scheduledStart, scheduledEnd]);

    const immediate = await handleAnnouncementAdminRequest(
      publishRequest(IMMEDIATE_ID),
      ACTOR,
      client,
      NOW,
    );
    assert.equal(immediate.status, 200, await immediate.clone().text());
    const immediateBody = await immediate.json() as {
      announcement: { effectiveStatus: string; startsAt: string | null; activatedAt: string | null };
    };
    assert.equal(immediateBody.announcement.effectiveStatus, "published");
    assert.equal(immediateBody.announcement.startsAt, NOW.toISOString());
    assert.equal(immediateBody.announcement.activatedAt, NOW.toISOString());

    const scheduled = await handleAnnouncementAdminRequest(
      publishRequest(SCHEDULED_ID),
      ACTOR,
      client,
      NOW,
    );
    assert.equal(scheduled.status, 200, await scheduled.clone().text());
    const scheduledBody = await scheduled.json() as {
      announcement: { effectiveStatus: string; startsAt: string | null; activatedAt: string | null };
    };
    assert.equal(scheduledBody.announcement.effectiveStatus, "scheduled");
    assert.equal(scheduledBody.announcement.startsAt, scheduledStart.toISOString());
    assert.equal(scheduledBody.announcement.activatedAt, null);

    const rows = await client.query(`
      SELECT id::text, status, starts_at, published_at, activated_at,
             published_by_user_id::text, updated_by_user_id::text
      FROM announcements
      ORDER BY id
    `);
    assert.deepEqual(rows.rows, [
      {
        id: IMMEDIATE_ID,
        status: "published",
        starts_at: NOW,
        published_at: NOW,
        activated_at: NOW,
        published_by_user_id: ACTOR,
        updated_by_user_id: ACTOR,
      },
      {
        id: SCHEDULED_ID,
        status: "published",
        starts_at: scheduledStart,
        published_at: NOW,
        activated_at: null,
        published_by_user_id: ACTOR,
        updated_by_user_id: ACTOR,
      },
    ]);
    const audits = await client.query(`
      SELECT announcement_id::text, actor_user_id::text, action
      FROM announcement_audit_events
      ORDER BY announcement_id, created_at, action
    `);
    assert.deepEqual(audits.rows, [
      { announcement_id: IMMEDIATE_ID, actor_user_id: ACTOR, action: "published" },
      { announcement_id: IMMEDIATE_ID, actor_user_id: null, action: "activated" },
      { announcement_id: SCHEDULED_ID, actor_user_id: ACTOR, action: "scheduled" },
    ]);
  } finally {
    await client.end().catch(() => undefined);
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
