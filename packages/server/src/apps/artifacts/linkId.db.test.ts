// The registration's linkId (AppObjectKind.linkId; core's check of a saved
// profile description's links, #457): a link names an Artifact by its id,
// any version of it, only on Raft's own hosts; and the id it gives is one
// `homes` finds (a short link included), so core can tell where it lives.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { artifactPagePath, asArtifactId, asServerId } from "@botiverse/raft-shared";
import { dbTest as test } from "../../test/integration/dbTest";
import { artifactsApp } from "./register";
import { artifactItems } from "./schema";

const kind = artifactsApp.objectKinds[0]!;
const linkId = (url: string) => kind.linkId!(url);

test("a link names an Artifact by its id on Raft's hosts, its version dropped; names, old links and other addresses name none", () => {
  const uuid = randomUUID();
  const id = asArtifactId(`pt_${uuid}`);
  const short = `https://app.raft.build${artifactPagePath(id)}`;
  assert.equal(linkId(short), id, "the short link every Raft link is");
  assert.equal(linkId(`https://app.raft.build${artifactPagePath(id, 3)}`), id, "a pinned version names the Artifact");
  assert.equal(linkId(`https://app.raft.build/s/acme/artifacts/${id}`), id);
  assert.equal(linkId(`https://artifacts.raft.build/${id}`), id);
  assert.equal(linkId(`https://a-pt-${uuid}.raftusercontent.com/index.html`), id, "the content origin");
  assert.equal(linkId(`https://evil.example${artifactPagePath(id)}`), null, "another host's /artifacts/ path is a plain link");
  assert.equal(linkId("https://raft-artifacts.com/p/acme/roadmap"), null, "a legacy link by name");
  assert.equal(linkId("https://raft-artifacts.com/a/sometoken"), null, "a legacy per-version link");
  assert.equal(linkId("https://app.raft.build/artifacts/not-an-id!"), null);
  assert.equal(linkId("https://github.com/botiverse/slock"), null);
  assert.equal(linkId(id), null, "a bare id is no link");
});

test("the id of a short link is one homes finds; a revoked or deleted one has no home", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const row = (revoked: boolean, deleted: boolean) => {
    const id = `pt_${randomUUID()}`;
    return {
      id, serverId: asServerId(server.id), urlKey: id, name: id, title: `Artifact ${id}`, homeKind: "server" as const, homeChannelId: null,
      createdByType: "user" as const, createdById: owner.id, revokedAt: revoked ? new Date() : null, deletedAt: deleted ? new Date() : null,
    };
  };
  const [live, revoked, deleted] = [row(false, false), row(true, false), row(false, true)];
  await db.insert(artifactItems).values([live, revoked, deleted]);
  const ids = [live, revoked, deleted].map((item) => linkId(`https://app.raft.build${artifactPagePath(asArtifactId(item.id))}`));
  assert.deepEqual(ids, [live.id, revoked.id, deleted.id]);
  const homes = await kind.homes(ids.map((id) => id!));
  assert.deepEqual([...homes.keys()], [live.id]);
  assert.equal(homes.get(live.id)!.homeKind, "server");
});
