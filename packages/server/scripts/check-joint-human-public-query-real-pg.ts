import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import {
  openTestDatabase,
  closeTestDatabase,
} from "../src/test/integration/database";
import { createSeed } from "../src/test/integration/seed";
import {
  users,
  serverMembers,
  jointChannelMembers,
  jointChannelAdmissions,
} from "../src/db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
} from "../src/services/channelService";
import {
  resolveJointHumanMembershipScopes,
  getComputedJointHumanPublicRowsForScopes,
} from "../src/services/jointHumanMembershipAccess";
const url = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL;
if (!url) throw new Error("disposable migrated PostgreSQL required");
const db = await openTestDatabase(url);
try {
  const seed = createSeed(db),
    owner = await seed.human(),
    h = await seed.server({ owner }),
    b = await seed.server({ owner });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "public-query",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  const people = Array.from({ length: 150 }, () => ({
    id: randomUUID(),
    email: randomUUID() + "@test.invalid",
    name: "public-query-" + randomUUID(),
    passwordHash: "synthetic",
  }));
  await db.insert(users).values(people);
  await db.insert(serverMembers).values(
    people.flatMap((user) =>
      [h.id, b.id].map((serverId) => ({
        serverId,
        userId: user.id,
        role: "member" as const,
      })),
    ),
  );
  await db.insert(jointChannelMembers).values(
    people.map((user) => ({
      jointChannelId: created.jointChannel.id,
      userId: user.id,
    })),
  );
  await db.insert(jointChannelAdmissions).values(
    people.flatMap((user) =>
      [h.id, b.id].map((serverId) => ({
        jointChannelId: created.jointChannel.id,
        userId: user.id,
        serverId,
      })),
    ),
  );
  await db.execute(sql`INSERT INTO servers(id,name,slug,owner_id)
   SELECT gen_random_uuid(),'unrelated source','unrelated-'||gen_random_uuid(),${owner.id}::uuid FROM generate_series(1,3000)`);
  for (const table of [
    "users",
    "servers",
    "server_members",
    "joint_channel_members",
    "joint_channel_admissions",
  ]) {
    await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
  }
  const scopes = await resolveJointHumanMembershipScopes(
    { localChannelIds: [created.channel.id, target.id] },
    db,
  );
  const captured: SQL[] = [];
  const observed = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "execute")
        return async (statement: SQL) => {
          captured.push(statement);
          return db.execute(statement);
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const roster = await getComputedJointHumanPublicRowsForScopes(
    [...scopes.values()],
    undefined,
    observed,
  );
  assert.equal(
    captured.length,
    1,
    "batching two projections requires one public-roster query",
  );
  assert.equal(roster.length, 302);
  assert.ok(
    roster.every(({ human, localChannelId }) =>
      human.servers.every(source => source.id === (localChannelId===created.channel.id ? b.id : h.id)),
    ),
  );
  const explain = await db.execute(
    sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${captured[0]!}`,
  );
  const plan = explain.rows[0]!["QUERY PLAN"];
  if (process.env.JOINT_MEMBERSHIP_EXPLAIN_FILE)
    writeFileSync(
      process.env.JOINT_MEMBERSHIP_EXPLAIN_FILE,
      JSON.stringify(plan, null, 2) + "\n",
    );
  console.log(
    "PASS one actual public query for 2 entry views / 151 humans / 302 rows with 3,000 unrelated servers; EXPLAIN ANALYZE recorded",
  );
} finally {
  await closeTestDatabase();
}
