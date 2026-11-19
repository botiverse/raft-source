/**
 * #244 (inbox redesign, step 1): the unread predicate cases
 * (packages/shared/contract-cases/activity-row/, `rule: "predicate"`) against
 * the server's own rules, so web, the app and the server agree by test:
 *
 * - the RisingWave `unread_count` FILTER, read as text from
 *   infra/risingwave/sql/075-inbox-cursor-decouple.sql (rw_inbox_normal_v5)
 *   and executed in Postgres (PGlite) over the case's message, with the muted
 *   arm's boundary (rw_inbox_muted_prefix_v2) for a muted case and the task
 *   conversation FILTER (078-task-conversations.sql) for a task row;
 * - the canonical Postgres read's rules (getInboxItems: search, guest access,
 *   forced reads), the very fragments its query composes:
 *   inboxRowMessageCountsUnreadSql for `counts` and inboxPersonalMentionSql
 *   for `mention` (inboxUnreadEligibility.ts), executed in PGlite over the
 *   case's message and its mention rows;
 * - isMessageUnreadEligibleForReceiver / countsTowardTaskConversationUnread
 *   (inboxUnreadEligibility.ts), the application-side copy of the rule.
 *
 * `mention` is checked against the Postgres @ rule only: in RisingWave the @ is
 * the mention arm (rw_inbox_mention_v7), not the unread FILTER. Client-only
 * scope facts (read on arrival, an unfollowed thread row, an event without the
 * system provenance) have no server rule here and are reported as skipped. A
 * pending case (none today) is checked against its `server` candidate, so the
 * disagreement it records stays true.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  countsTowardTaskConversationUnread,
  inboxPersonalMentionSql,
  inboxRowMessageCountsUnreadSql,
  isMessageUnreadEligibleForReceiver,
} from "./inboxUnreadEligibility";

type Message = {
  senderType: string; senderId: string; messageType: "chat" | "system";
  causalActorType?: string | null; causalActorId?: string | null; systemSubtype?: string | null;
  mentions?: { type: string; id: string }[];
};
type Scope = { rowKind: "channel" | "dm" | "thread" | "task"; threadFollowed?: boolean; activityMuted?: boolean; readOnArrival?: boolean };
type Verdict = { counts: boolean | null; mention: boolean };
type PredicateCase = {
  id: string;
  rule: string;
  status: "agreed" | "pending-product-decision";
  given: { viewer: { type: "user" | "agent"; id: string }; scope: Scope; message: Message };
  expect?: { verdict: Verdict };
  decision?: { candidates: { id: string; currentBehaviourOf: string[]; expect: { verdict: Verdict } }[] };
};

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const casesDir = join(repoRoot, "packages/shared/contract-cases/activity-row/cases");
const cases = readdirSync(casesDir).filter((name) => name.endsWith(".json")).sort()
  .map((name) => JSON.parse(readFileSync(join(casesDir, name), "utf8")) as { rule: string })
  .filter((value): value is PredicateCase => value.rule === "predicate");

const sql075 = readFileSync(join(repoRoot, "infra/risingwave/sql/075-inbox-cursor-decouple.sql"), "utf8");
const sql078 = readFileSync(join(repoRoot, "infra/risingwave/sql/078-task-conversations.sql"), "utf8");
const sqlJcm = readFileSync(join(repoRoot, "infra/risingwave/sql/081-computed-joint-members/11-rw_inbox_normal_jcm_v1.sql"), "utf8");

function unreadFilter(text: string, from: string): string {
  const view = text.slice(text.indexOf(from));
  const match = /COUNT\(u\.seq\) FILTER \(WHERE ([\s\S]*?)\)\s*AS unread_count/.exec(view);
  assert.ok(match, `no unread_count FILTER after ${from}`);
  return match[1]!.replace(/\s+/g, " ").trim();
}

const NORMAL_FILTER = unreadFilter(sql075, "CREATE MATERIALIZED VIEW rw_inbox_normal_v5");
const TASK_FILTER = unreadFilter(sql078, "COUNT(u.seq) FILTER (WHERE u.message_type = 'chat'");
/** The muted prefix arm's message boundary (a join condition, not the FILTER). */
const MUTE_BOUNDARY = (() => {
  const view = sql075.slice(sql075.indexOf("CREATE MATERIALIZED VIEW rw_inbox_muted_prefix_v2"));
  const match = /AND (\(a\.mute_from_seq IS NULL OR u\.seq < a\.mute_from_seq\))/.exec(view);
  assert.ok(match, "no mute boundary in rw_inbox_muted_prefix_v2");
  return match[1]!.replaceAll("a.", "s.");
})();

/** Why the server has no rule to check for this case, or null. */
function notServerDecided({ given }: PredicateCase): string | null {
  if (given.scope.readOnArrival) return "read on arrival is client-only";
  if ((given.scope.rowKind === "thread" || given.scope.rowKind === "task") && given.scope.threadFollowed === false) return "an unfollowed thread row is not in the count";
  if (given.message.messageType === "system" && given.message.systemSubtype === undefined) return "the server always has the system provenance";
  return null;
}

function expectedVerdict(contractCase: PredicateCase): Verdict | undefined {
  if (contractCase.status === "agreed") return contractCase.expect?.verdict;
  return contractCase.decision?.candidates.find((candidate) => candidate.currentBehaviourOf.includes("server"))?.expect.verdict;
}

/**
 * Why the Postgres @ rule is not checked for this case, or null. An own
 * message is behind the sender's read cursor (a send advances it), which the
 * caller applies; neither @ rule (Postgres or rw_inbox_mention_v7) reads the
 * sender.
 */
function mentionNotRuleDecided({ given }: PredicateCase): string | null {
  if (given.message.senderType === given.viewer.type && given.message.senderId === given.viewer.id) {
    return "an own message is behind the sender's read cursor";
  }
  return null;
}

let db: PGlite;
const dialect = new PgDialect();

/** The case's actor ids ("viewer-1") as UUIDs: message_mentions.target_id is a uuid. */
const actorUuids = new Map<string, string>();
function actorUuid(id: string): string {
  let uuid = actorUuids.get(id);
  if (!uuid) {
    uuid = `00000000-0000-4000-8000-${(actorUuids.size + 1).toString(16).padStart(12, "0")}`;
    actorUuids.set(id, uuid);
  }
  return uuid;
}

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE TABLE messages (
      id text PRIMARY KEY, seq bigint NOT NULL, sender_type text NOT NULL, sender_id text NOT NULL,
      message_type text NOT NULL, causal_actor_type text, causal_actor_id text, system_subtype text
    );
    CREATE TABLE message_mentions (
      message_id text NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL,
      notifiable_at_send boolean NOT NULL, notified_at timestamptz
    );
  `);
});

afterAll(async () => {
  await db.close();
});

/** The SQL rule over one message (seq 101) for one receiver; a muted scope's boundary is at 100, before the message. */
async function sqlCounts({ given }: PredicateCase): Promise<boolean> {
  const { message, viewer, scope } = given;
  const filter = scope.rowKind === "task" ? TASK_FILTER : NORMAL_FILTER;
  const muted = scope.activityMuted && scope.rowKind !== "thread" && scope.rowKind !== "task";
  const result = await db.query<{ counts: boolean }>(
    `SELECT COALESCE((${filter})${muted ? ` AND ${MUTE_BOUNDARY}` : ""}, FALSE) AS counts
     FROM (VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, 101::bigint))
            AS u(sender_type, sender_id, message_type, causal_actor_type, causal_actor_id, system_subtype, seq),
          (VALUES ($7::text, $8::text, ${muted ? "100" : "NULL"}::bigint)) AS s(receiver_type, receiver_id, mute_from_seq)`,
    [message.senderType, message.senderId, message.messageType, message.causalActorType ?? null, message.causalActorId ?? null,
      message.systemSubtype ?? null, viewer.type, viewer.id],
  );
  return result.rows[0]!.counts;
}

/**
 * The canonical Postgres rules, as getInboxItems composes them, over one
 * message (seq 101) and its mention rows; a muted scope's boundary is at 100.
 */
async function postgresVerdict({ id, given }: PredicateCase): Promise<{ counts: boolean; mention: boolean }> {
  const { message, viewer, scope } = given;
  assert.equal(viewer.type, "user", "the Postgres Activity read is a user's");
  const muted = scope.activityMuted && scope.rowKind !== "thread" && scope.rowKind !== "task";
  const actor = (value: string | null | undefined) => (value == null || value === "system" ? value ?? null : actorUuid(value));
  const userId = actorUuid(viewer.id);
  await db.query("DELETE FROM message_mentions");
  await db.query("DELETE FROM messages");
  await db.query(
    "INSERT INTO messages VALUES ($1, 101, $2, $3, $4, $5, $6, $7)",
    [id, message.senderType, actor(message.senderId), message.messageType, message.causalActorType ?? null,
      actor(message.causalActorId), message.systemSubtype ?? null],
  );
  for (const mention of message.mentions ?? []) {
    await db.query("INSERT INTO message_mentions VALUES ($1, $2, $3, true, NULL)", [id, mention.type, actorUuid(mention.id)]);
  }
  const counts: SQL = inboxRowMessageCountsUnreadSql({
    message: sql`m`,
    userId,
    muteFromSeq: muted ? sql`100::bigint` : sql`NULL::bigint`,
    isTaskConversation: scope.rowKind === "task" ? sql`true` : sql`false`,
  });
  const query = dialect.sqlToQuery(sql`
    SELECT COALESCE(${counts}, FALSE) AS counts,
           EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND ${inboxPersonalMentionSql(sql`mm`, userId)}) AS mention
    FROM messages m`);
  const result = await db.query<{ counts: boolean; mention: boolean }>(query.sql, query.params);
  return result.rows[0]!;
}

function applicationCounts({ given }: PredicateCase): boolean {
  const { message, viewer, scope } = given;
  if (scope.activityMuted && scope.rowKind !== "thread" && scope.rowKind !== "task") return false;
  if (scope.rowKind === "task") return message.senderType !== viewer.type || message.senderId !== viewer.id ? countsTowardTaskConversationUnread(message) : false;
  return isMessageUnreadEligibleForReceiver(message, viewer);
}

describe("activity row predicate cases against the server's unread rule", () => {
  it("reads the FILTER the joint (jcm) inbox view uses too", () => {
    assert.equal(unreadFilter(sqlJcm, "CREATE MATERIALIZED VIEW"), NORMAL_FILTER);
    assert.ok(cases.length > 0);
  });

  for (const contractCase of cases) {
    const skip = notServerDecided(contractCase);
    if (skip) {
      it.skip(`${contractCase.id} (skipped: ${skip})`, () => {});
      continue;
    }
    const label = contractCase.status === "agreed" ? "" : " (pending: the server candidate)";
    it(`${contractCase.id}${label}`, async () => {
      const verdict = expectedVerdict(contractCase);
      const expected = verdict?.counts;
      assert.equal(typeof expected, "boolean", "a server-decided case names the server's count");
      assert.equal(await sqlCounts(contractCase), expected, "RisingWave unread_count FILTER");
      const postgres = await postgresVerdict(contractCase);
      assert.equal(postgres.counts, expected, "Postgres inboxRowMessageCountsUnreadSql");
      if (!mentionNotRuleDecided(contractCase)) assert.equal(postgres.mention, verdict!.mention, "Postgres inboxPersonalMentionSql");
      assert.equal(applicationCounts(contractCase), expected, "isMessageUnreadEligibleForReceiver");
    });
  }
});
