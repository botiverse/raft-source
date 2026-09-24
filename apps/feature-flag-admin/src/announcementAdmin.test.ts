import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { handleAnnouncementAdminRequest } from "./announcementAdmin";

// PostgreSQL accepts the full canonical UUID bit space. This synthetic legacy
// row has version=0 and variant=0, matching the compatibility shape that every
// item route must continue to accept.
const ID = "11111111-1111-0111-0111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-09T09:30:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: "Hello",
    pages: [{ body: "World" }],
    default_locale: "en",
    localized_content: { en: { title: "Hello", pages: [{ body: "World" }] } },
    status: "draft",
    starts_at: null,
    ends_at: null,
    published_at: null,
    activated_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by_user_id: ACTOR,
    updated_by_user_id: ACTOR,
    published_by_user_id: null,
    ...overrides,
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://flags.test${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function client(query: (text: string, values: unknown[]) => Array<Record<string, unknown>>): Client {
  return {
    query: async (text: string, values: unknown[] = []) => ({ rows: query(text, values) }),
  } as unknown as Client;
}

const draftInput = {
  defaultLocale: "en",
  content: { en: { title: "Hello", pages: [{ body: "World" }] } },
  startsAt: null,
  endsAt: null,
};

test("announcement admin owns every lifecycle route through direct transactional PG", async () => {
  const list = await handleAnnouncementAdminRequest(
    request("/api/operator/announcements"),
    ACTOR,
    client((text) => {
      if (text.includes("activated_at IS NULL")) return [];
      if (text.includes("ORDER BY created_at DESC")) return [row()];
      throw new Error(`unexpected list SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { announcements: Array<{ id: string }> }).announcements.map((item) => item.id), [ID]);

  let createAuditActor: unknown;
  const created = await handleAnnouncementAdminRequest(
    request("/api/operator/announcements", "POST", draftInput),
    ACTOR,
    client((text, values) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("INSERT INTO announcements")) return [row()];
      if (text.includes("INSERT INTO announcement_audit_events")) {
        createAuditActor = values[2];
        return [];
      }
      throw new Error(`unexpected create SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(createAuditActor, ACTOR);

  const updated = await handleAnnouncementAdminRequest(
    request(`/api/operator/announcements/${ID}`, "PATCH", draftInput),
    ACTOR,
    client((text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("FOR UPDATE")) return [row()];
      if (text.includes("UPDATE announcements") && text.includes("SET title")) return [row()];
      if (text.includes("INSERT INTO announcement_audit_events")) return [];
      throw new Error(`unexpected update SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(updated.status, 200, await updated.clone().text());

  const publishedRow = row({
    status: "published",
    starts_at: NOW,
    published_at: NOW,
    activated_at: NOW,
    published_by_user_id: ACTOR,
  });
  const published = await handleAnnouncementAdminRequest(
    request(`/api/operator/announcements/${ID}/publish`, "POST"),
    ACTOR,
    client((text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("WHERE id = $1 AND status = 'draft'") && text.includes("FOR UPDATE")) return [row()];
      if (text.includes("WHERE status = 'published'") && text.includes("FOR SHARE")) return [];
      if (text.includes("SET status = 'published'")) return [publishedRow];
      if (text.includes("INSERT INTO announcement_audit_events")) return [];
      throw new Error(`unexpected publish SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(published.status, 200, await published.clone().text());

  const future = new Date("2030-01-01T00:00:00.000Z");
  const scheduledRow = row({ status: "published", starts_at: future, published_at: NOW });
  const cancelled = await handleAnnouncementAdminRequest(
    request(`/api/operator/announcements/${ID}/cancel`, "POST"),
    ACTOR,
    client((text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("WHERE id = $1 AND status = 'published'") && text.includes("FOR UPDATE")) return [scheduledRow];
      if (text.includes("SET status = 'draft'")) return [row({ starts_at: future })];
      if (text.includes("INSERT INTO announcement_audit_events")) return [];
      throw new Error(`unexpected cancel SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(cancelled.status, 200, await cancelled.clone().text());

  let expireActor: unknown;
  const expired = await handleAnnouncementAdminRequest(
    request(`/api/operator/announcements/${ID}/expire`, "POST"),
    ACTOR,
    client((text, values) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("SET status = 'expired'")) return [row({
        status: "expired",
        starts_at: new Date(NOW.getTime() - 1_000),
        ends_at: NOW,
        published_at: new Date(NOW.getTime() - 2_000),
      })];
      if (text.includes("INSERT INTO announcement_audit_events")) {
        expireActor = values[2];
        return [];
      }
      throw new Error(`unexpected expire SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(expired.status, 200, await expired.clone().text());
  assert.equal(expireActor, ACTOR);
  assert.equal((await expired.json() as { announcement: { status: string } }).announcement.status, "expired");

  const audit = await handleAnnouncementAdminRequest(
    request(`/api/operator/announcements/${ID}/audit`),
    ACTOR,
    client((text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return [];
      if (text.includes("UPDATE announcements") && text.includes("activated_at IS NULL")) return [];
      if (text.includes("FROM announcement_audit_events")) return [{
        id: "33333333-3333-4333-8333-333333333333",
        announcement_id: ID,
        actor_user_id: ACTOR,
        action: "expired",
        created_at: NOW,
      }];
      throw new Error(`unexpected audit SQL ${text}`);
    }),
    NOW,
  );
  assert.equal(audit.status, 200, await audit.clone().text());
  assert.deepEqual((await audit.json() as { events: Array<{ action: string }> }).events.map((event) => event.action), ["expired"]);
});

test("announcement item routes reject malformed canonical IDs before querying PG", async () => {
  for (const [path, method] of [
    ["/api/operator/announcements/not-a-uuid", "PATCH"],
    ["/api/operator/announcements/not-a-uuid/publish", "POST"],
    ["/api/operator/announcements/not-a-uuid/expire", "POST"],
    ["/api/operator/announcements/not-a-uuid/cancel", "POST"],
    ["/api/operator/announcements/not-a-uuid/audit", "GET"],
    ["/api/operator/announcements/%E0%A4%A/audit", "GET"],
  ] as const) {
    let queried = false;
    const response = await handleAnnouncementAdminRequest(
      request(path, method, method === "PATCH" ? draftInput : undefined),
      ACTOR,
      client(() => {
        queried = true;
        return [];
      }),
      NOW,
    );
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.equal(queried, false, `${method} ${path} must fail before PG`);
    assert.deepEqual(await response.json(), { error: "announcement id must be a valid UUID" });
  }
});
