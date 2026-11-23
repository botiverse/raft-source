// object_references (services/objectReferences.ts, platform/references): one
// source's references replaced all at once, in order, at most
// OBJECT_REFERENCES_MAX_PER_SOURCE; an unregistered kind refused with nothing
// written; another source's rows untouched; deleted with the source; the
// facts' size, the position and the key held by the table. A chat message as
// a core source (services/messageReferences.ts, #proj-workspace:#336 step 2):
// never a target; its rows follow its current content only (a write for
// content it no longer has, or for a retracted message, is dropped); no work
// for text without an address on Raft's hosts.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { artifactLinkId, asServerId, type ArtifactId } from "@botiverse/raft-shared";
import { getAppUrl } from "../config/appUrl";
import { getDb } from "../db/index";
import { messages, objectReferences } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { messageObjectLinks, MESSAGE_OBJECT_LINK_LIMIT } from "./firstPartyAppMessageLinks";
import {
  deleteMessageReferences,
  drainMessageReferencesForTests,
  mayLinkObjects,
  messageReferencesOf,
  recordMessageReferences,
  writeMessageReferences,
} from "./messageReferences";
import {
  CORE_SOURCE_KINDS,
  deleteReferencesOfSource,
  OBJECT_REFERENCES_MAX_PER_SOURCE,
  ObjectReferenceRejected,
  referencesOfSource,
  replaceReferences,
} from "./objectReferences";

const violates = (constraint: string) => (error: unknown) => {
  const text = `${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}`;
  return text.includes(constraint);
};

test("replace, read back in order, cap, refuse unknown kinds, delete with the source", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const source = { serverId, kind: "artifact", id: `pt_${randomUUID()}` };
  const other = { serverId, kind: "artifact", id: `pt_${randomUUID()}` };
  const target = (n: number) => ({ kind: "artifact", id: `pt_target-${n}`, detail: { version: n, bare: n % 2 === 0 } });

  await replaceReferences(db, other, [target(9)]);
  await replaceReferences(db, source, [target(1), target(2)]);
  assert.deepEqual(await referencesOfSource(db, "artifact", source.id), [target(1), target(2)]);
  await replaceReferences(db, source, [target(3)]);
  assert.deepEqual(await referencesOfSource(db, "artifact", source.id), [target(3)], "replaced, not added to");

  const many = Array.from({ length: OBJECT_REFERENCES_MAX_PER_SOURCE + 5 }, (_, n) => target(n));
  await replaceReferences(db, source, many);
  const kept = await referencesOfSource(db, "artifact", source.id);
  assert.equal(kept.length, OBJECT_REFERENCES_MAX_PER_SOURCE);
  assert.deepEqual(kept.at(-1), target(OBJECT_REFERENCES_MAX_PER_SOURCE - 1), "the first ones");

  await assert.rejects(replaceReferences(db, { ...source, kind: "nope" }, []), ObjectReferenceRejected);
  await assert.rejects(replaceReferences(db, source, [{ kind: "nope", id: "x", detail: {} }]), ObjectReferenceRejected);
  assert.equal((await referencesOfSource(db, "artifact", source.id)).length, OBJECT_REFERENCES_MAX_PER_SOURCE, "nothing written on a refusal");

  await replaceReferences(db, source, []);
  assert.deepEqual(await referencesOfSource(db, "artifact", source.id), []);
  await replaceReferences(db, source, [target(4)]);
  assert.equal(await deleteReferencesOfSource(db, "artifact", source.id), 1);
  assert.deepEqual(await referencesOfSource(db, "artifact", other.id), [target(9)], "another source's rows stay");
});

test("the table holds its limits", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const row = { serverId: server.id, sourceKind: "artifact", sourceId: `pt_${randomUUID()}`, position: 0, targetKind: "artifact", targetId: "pt_t" };
  await assert.rejects(db.insert(objectReferences).values({ ...row, position: -1 }), violates("object_references_position"));
  await assert.rejects(db.insert(objectReferences).values({ ...row, targetDetail: { href: randomBytes(6000).toString("base64") } }), violates("object_references_detail_small"));
  await db.insert(objectReferences).values(row);
  await assert.rejects(db.insert(objectReferences).values(row), violates("object_references_source_kind_source_id_position_pk"));
  assert.equal((await db.select().from(objectReferences).where(eq(objectReferences.sourceId, row.sourceId))).length, 1);
});

const artifactId = () => `pt_${randomUUID()}`;
const appLink = (id: string) => `${getAppUrl()}/artifacts/${artifactLinkId(id as ArtifactId)}`;
/** The stored references of message `id`, as (target id, bare) pairs, in order. */
const messageTargets = async (id: string) =>
  (await referencesOfSource(getDb(), "message", id)).map((ref) => [ref.kind, ref.id, (ref.detail as { bare?: boolean }).bare]);

test("a message is a core source, never a target", async ({ seed }) => {
  const db = getDb();
  assert.ok(CORE_SOURCE_KINDS.has("message"));
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const source = { serverId: asServerId(server.id), kind: "message", id: randomUUID() };
  await replaceReferences(db, source, [{ kind: "artifact", id: "pt_t", detail: { href: "https://x", bare: true } }]);
  assert.deepEqual(await referencesOfSource(db, "message", source.id), [{ kind: "artifact", id: "pt_t", detail: { href: "https://x", bare: true } }]);
  await assert.rejects(replaceReferences(db, { ...source, kind: "artifact", id: `pt_${randomUUID()}` }, [{ kind: "message", id: source.id, detail: {} }]), ObjectReferenceRejected, "a message is no target");
  assert.equal(await deleteReferencesOfSource(db, "message", source.id), 1);
});

test("mayLinkObjects: only text with an address on Raft's hosts (app hosts, a kind's linkHosts), any case", () => {
  const id = artifactId();
  assert.equal(mayLinkObjects("no links at all"), false);
  assert.equal(mayLinkObjects(`https://evil.example/artifacts/${id}`), false, "another host");
  assert.equal(mayLinkObjects(`${new URL(getAppUrl()).hostname} without a scheme`), false, "no ://");
  assert.equal(mayLinkObjects(`see ${appLink(id)}`), true);
  assert.equal(mayLinkObjects(`HTTPS://ARTIFACTS.RAFT.BUILD/${id}`), true, "the redirect host, upper case");
  assert.equal(mayLinkObjects(`https://a-${id.replace("_", "-")}.raftusercontent.com/index.html`), true, "the content origin");
});

test("a message's references: its visible object links, each once, in order, up to the table's cap (not the cards' ten); one shared walk", () => {
  const [a, b] = [artifactId(), artifactId()];
  const content = `first ${appLink(a)}, [with words](https://artifacts.raft.build/${b}), again ${appLink(a)}/v/2, in code \`${appLink(artifactId())}\`, elsewhere https://evil.example/artifacts/${artifactId()}`;
  assert.deepEqual(messageReferencesOf(content).map((ref) => [ref.kind, ref.id, ref.detail.bare]), [["artifact", a, true], ["artifact", b, false]]);
  assert.deepEqual(Object.keys(messageReferencesOf(content)[0]!.detail).sort(), ["bare", "href"], "the link only, never the text");
  const many = Array.from({ length: OBJECT_REFERENCES_MAX_PER_SOURCE + 5 }, () => appLink(artifactId())).join("\n");
  assert.equal(messageReferencesOf(many).length, OBJECT_REFERENCES_MAX_PER_SOURCE);
  assert.equal(messageObjectLinks(many, MESSAGE_OBJECT_LINK_LIMIT).length, MESSAGE_OBJECT_LINK_LIMIT, "the apps are told of the first ten");
});

test("a message's rows follow its current content: written under its row lock, a write for content it no longer has or once retracted dropped", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const [a, b] = [artifactId(), artifactId()];
  const message = await seed.message({ channel, author: owner, content: `look ${appLink(a)} and ${appLink(b)}` });

  assert.equal(await writeMessageReferences(message.id, message.content), "written");
  assert.deepEqual(await messageTargets(message.id), [["artifact", a, true], ["artifact", b, true]]);
  const [row] = await db.select({ serverId: objectReferences.serverId }).from(objectReferences)
    .where(and(eq(objectReferences.sourceKind, "message"), eq(objectReferences.sourceId, message.id))).limit(1);
  assert.equal(row!.serverId, server.id, "the message's storage server");
  assert.equal(await writeMessageReferences(message.id, message.content), "written", "again: the same rows");
  assert.deepEqual(await messageTargets(message.id), [["artifact", a, true], ["artifact", b, true]]);

  // An edit: the new content's write replaces the rows; a late write for the old content is dropped.
  const edited = `only ${appLink(b)} now`;
  await db.update(messages).set({ content: edited }).where(eq(messages.id, message.id));
  assert.equal(await writeMessageReferences(message.id, edited), "written");
  assert.equal(await writeMessageReferences(message.id, message.content), "stale");
  assert.deepEqual(await messageTargets(message.id), [["artifact", b, true]]);

  // Retracted: a write still to come writes nothing; the retraction's delete clears them.
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id));
  assert.equal(await writeMessageReferences(message.id, edited), "stale");
  await deleteMessageReferences(db, message.id, edited);
  assert.deepEqual(await messageTargets(message.id), []);
});

test("recordMessageReferences: after the call, on a later tick; nothing for text without an address on Raft's hosts; an edit away from links deletes them", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const a = artifactId();
  const linking = await seed.message({ channel, author: owner, content: `see ${appLink(a)}` });
  recordMessageReferences({ messageId: linking.id, content: linking.content, previousContent: null });
  assert.deepEqual(await messageTargets(linking.id), [], "not in the caller's tick");
  await drainMessageReferencesForTests();
  assert.deepEqual(await messageTargets(linking.id), [["artifact", a, true]]);

  const plain = await seed.message({ channel, author: owner, content: "no address here https://example.com" });
  recordMessageReferences({ messageId: plain.id, content: plain.content, previousContent: null });
  await drainMessageReferencesForTests();
  assert.deepEqual(await messageTargets(plain.id), []);

  const edited = "the link is gone";
  await db.update(messages).set({ content: edited }).where(eq(messages.id, linking.id));
  recordMessageReferences({ messageId: linking.id, content: edited, previousContent: linking.content });
  await drainMessageReferencesForTests();
  assert.deepEqual(await messageTargets(linking.id), [], "the old text's rows deleted");
});
