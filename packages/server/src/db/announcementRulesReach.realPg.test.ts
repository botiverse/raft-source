// announcement_rules_reach (0617) must count exactly the accounts the shared
// matchesAnnouncementRules would let through in some Server they belong to,
// counting feature_flag / platform as matching and hiding counts below 5.
// Skipped unless ANNOUNCEMENT_RULES_REACH_REAL_PG_URL names an admin URL.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { test } from "vitest";
import {
  matchesAnnouncementRules,
  validateAnnouncementAudienceRules,
  type AnnouncementAudienceRules,
  type AnnouncementRuleContext,
} from "@botiverse/raft-shared/announcement-audience";

const ADMIN_URL = process.env.ANNOUNCEMENT_RULES_REACH_REAL_PG_URL;
const REQUIRED = process.env.ANNOUNCEMENT_RULES_REACH_REAL_PG_REQUIRED === "1";
const NOW = new Date("2026-11-05T00:00:00.000Z");
const DAY = 24 * 60 * 60_000;

const migration = readFileSync(new URL("../../drizzle/0617_announcement_rules_reach.sql", import.meta.url), "utf8");
const createFunction = migration.slice(0, migration.indexOf("--> statement-breakpoint"));

// Deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type User = { id: string; createdAt: Date; locale: string | null };
type Server = { id: string; createdAt: Date; plan: string; kind: string; deletedAt: Date | null };
type Member = { serverId: string; userId: string; role: string };

function uuid(prefix: number, index: number): string {
  return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fixtures(random: () => number) {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const users: User[] = Array.from({ length: 60 }, (_, i) => ({
    id: uuid(0x10000000, i),
    createdAt: new Date(NOW.getTime() - Math.floor(random() * 400) * DAY - Math.floor(random() * DAY)),
    locale: pick(["en", "en", "zh-cn", "ja", "fr", null]),
  }));
  const servers: Server[] = Array.from({ length: 8 }, (_, i) => ({
    id: uuid(0x20000000, i),
    createdAt: new Date(NOW.getTime() - Math.floor(random() * 400) * DAY),
    plan: pick(["free", "free", "pro", "founder", "partner"]),
    kind: i === 7 ? "joint_storage" : "workspace",
    deletedAt: i === 6 ? new Date(NOW.getTime() - DAY) : null,
  }));
  const members: Member[] = [];
  for (const user of users) {
    for (const server of servers) {
      if (random() < 0.3) members.push({ serverId: server.id, userId: user.id, role: pick(["owner", "admin", "member", "member", "guest"]) });
    }
  }
  return { users, servers, members };
}

function randomRules(random: () => number): AnnouncementAudienceRules {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const negate = () => (random() < 0.3 ? { negate: true as const } : {});
  const condition = () => {
    const field = pick(["account_created", "server_created", "server_role", "server_plan", "locale", "feature_flag", "platform"] as const);
    if (field === "account_created" || field === "server_created") {
      const op = pick(["within_days", "older_than_days", "after", "before"] as const);
      return op === "within_days" || op === "older_than_days"
        ? { field, op, days: 1 + Math.floor(random() * 300), ...negate() }
        : { field, op, date: new Date(NOW.getTime() - Math.floor(random() * 300) * DAY).toISOString().slice(0, 10), ...negate() };
    }
    if (field === "server_role") return { field, values: [pick(["owner", "admin", "member"])], ...negate() };
    if (field === "server_plan") return { field, values: [pick(["free", "pro", "founder"])], ...negate() };
    if (field === "locale") return { field, values: [pick(["en", "zh-cn", "ja"])], ...negate() };
    if (field === "feature_flag") return { field, key: "some_flag_v0", ...negate() };
    return { field, values: ["web"], ...negate() };
  };
  const groups = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
    match: pick(["all", "any"] as const),
    conditions: Array.from({ length: 1 + Math.floor(random() * 3) }, condition),
  }));
  return validateAnnouncementAudienceRules({ match: pick(["all", "any"] as const), groups });
}

const DISPLAY = new Set(["en", "es", "pt-br", "ko", "ja", "zh-cn", "zh-tw"]);

/** The oracle: the shared matcher, with per-request facts (flags, platform) forced to match. */
function expected(
  rules: AnnouncementAudienceRules,
  data: ReturnType<typeof fixtures>,
  scope: { type: "all" } | { type: "users"; userIds: string[] } | { type: "server_members"; serverIds: string[] } | { type: "server_users"; pairs: Array<[string, string]> },
): { count: number; scope: number } {
  const live = new Map(data.servers.filter((server) => !server.deletedAt && server.kind !== "joint_storage").map((server) => [server.id, server]));
  const matches = (user: User, server: Server | null, role: string | null) => {
    const ctxBase: Omit<AnnouncementRuleContext, "flags" | "platform"> = {
      now: NOW,
      accountCreatedAt: user.createdAt,
      locale: user.locale && DISPLAY.has(user.locale) ? user.locale as AnnouncementRuleContext["locale"] : null,
      server: server && role ? { createdAt: server.createdAt, plan: server.plan, role } : null,
    };
    // Each flag/platform condition must be true whatever its negate: evaluate per group by
    // replacing those conditions with a tautology the matcher understands.
    const tautology = { field: "account_created", op: "after", date: "1970-01-01" } as const;
    const replaced: AnnouncementAudienceRules = {
      ...rules,
      groups: rules.groups.map((group) => ({
        ...group,
        conditions: group.conditions.map((item) => item.field === "feature_flag" || item.field === "platform" ? tautology : item),
      })),
    };
    return matchesAnnouncementRules(replaced, { ...ctxBase, platform: null, flags: new Map() });
  };
  const counted = new Set<string>();
  const inScopeUsers = new Set<string>();
  for (const user of data.users) {
    const memberships = data.members.filter((member) => member.userId === user.id && member.role !== "guest" && live.has(member.serverId));
    const guestOnly = memberships.length === 0 && data.members.some((member) => member.userId === user.id && member.role === "guest" && live.has(member.serverId));
    const inScope = (serverId: string | null) => {
      if (scope.type === "all") return true;
      if (scope.type === "users") return scope.userIds.includes(user.id);
      if (serverId === null) return false;
      if (scope.type === "server_members") return scope.serverIds.includes(serverId);
      return scope.pairs.some(([sid, uid]) => sid === serverId && uid === user.id);
    };
    const accountWide = scope.type === "all" || scope.type === "users";
    if (accountWide && !guestOnly && inScope(null)) {
      inScopeUsers.add(user.id);
      if (matches(user, null, null)) counted.add(user.id);
    }
    for (const member of memberships) {
      if (!inScope(member.serverId)) continue;
      inScopeUsers.add(user.id);
      if (matches(user, live.get(member.serverId)!, member.role)) counted.add(user.id);
    }
  }
  return { count: counted.size, scope: inScopeUsers.size };
}

test("announcement_rules_reach matches the shared rule matcher on random fixtures", { skip: !ADMIN_URL && !REQUIRED }, async () => {
  assert.ok(ADMIN_URL, "ANNOUNCEMENT_RULES_REACH_REAL_PG_URL is required");
  const dbName = `rules_reach_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  try {
    await db.connect();
    await db.query(`
      CREATE TABLE public.users (id uuid PRIMARY KEY, created_at timestamptz NOT NULL, display_language text);
      CREATE TABLE public.servers (id uuid PRIMARY KEY, created_at timestamptz NOT NULL, plan text NOT NULL, kind text NOT NULL, deleted_at timestamptz);
      CREATE TABLE public.server_members (server_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, PRIMARY KEY (server_id, user_id));
    `);
    await db.query(createFunction);
    const random = rng(20261105);
    const data = fixtures(random);
    for (const user of data.users) await db.query("INSERT INTO public.users VALUES ($1, $2, $3)", [user.id, user.createdAt, user.locale]);
    for (const server of data.servers) await db.query("INSERT INTO public.servers VALUES ($1, $2, $3, $4, $5)", [server.id, server.createdAt, server.plan, server.kind, server.deletedAt]);
    for (const member of data.members) await db.query("INSERT INTO public.server_members VALUES ($1, $2, $3)", [member.serverId, member.userId, member.role]);

    const reach = async (rules: AnnouncementAudienceRules, scope: string, userIds: string[] | null, serverIds: string[] | null) =>
      (await db.query("SELECT public.announcement_rules_reach($1::jsonb, $2, $3::uuid[], $4::uuid[], $5) AS n", [JSON.stringify(rules), scope, userIds, serverIds, NOW])).rows[0].n as number | null;
    // Below 5 matches, or a listed scope under 20 accounts, the function answers NULL.
    const hidden = (want: { count: number; scope: number }, listed: boolean) =>
      want.count < 5 || (listed && want.scope < 20) ? null : want.count;

    let nonTrivial = 0;
    for (let round = 0; round < 150; round += 1) {
      const rules = randomRules(random);
      const someUsers = data.users.filter(() => random() < 0.4).map((user) => user.id);
      const someServers = data.servers.filter(() => random() < 0.5).map((server) => server.id);
      const pairs = data.members.filter(() => random() < 0.4).map((member) => [member.serverId, member.userId] as [string, string]);
      const cases = [
        { got: await reach(rules, "all", null, null), want: expected(rules, data, { type: "all" }), listed: false },
        { got: await reach(rules, "users", someUsers, null), want: expected(rules, data, { type: "users", userIds: someUsers }), listed: true },
        { got: await reach(rules, "server_members", null, someServers), want: expected(rules, data, { type: "server_members", serverIds: someServers }), listed: false },
        { got: await reach(rules, "server_users", pairs.map(([, uid]) => uid), pairs.map(([sid]) => sid)), want: expected(rules, data, { type: "server_users", pairs }), listed: true },
      ];
      for (const [index, item] of cases.entries()) {
        assert.equal(item.got, hidden(item.want, item.listed), `round ${round} case ${index}: ${JSON.stringify(rules)}`);
        if (item.got !== null && item.want.count < data.users.length) nonTrivial += 1;
      }
    }
    assert.ok(nonTrivial > 50, `fixtures exercise real narrowing (${nonTrivial} non-trivial counts)`);

    await assert.rejects(reach({ match: "all", groups: [] } as unknown as AnnouncementAudienceRules, "bogus", null, null), /unknown scope/);
  } finally {
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
});
