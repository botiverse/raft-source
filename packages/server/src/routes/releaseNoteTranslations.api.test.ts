import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  releaseNoteAudit, releaseNoteDrafts, releaseNoteRevisionItems, releaseNoteRevisions, releaseNotes, releaseNoteTranslations,
} from "../db/schema";
import {
  RELEASE_NOTE_TRANSLATION_LOCALES, releaseNoteSourceHash, writeReleaseNoteTranslations,
} from "../services/releaseNoteTranslations";
import { DISPLAY_LOCALES } from "@botiverse/raft-shared";

/**
 * Release-note translations: the database function the Release App calls
 * (`public.release_note_translations_write`, wrapped by
 * `writeReleaseNoteTranslations`) and the public read's `?locale=`.
 *
 * Pins:
 *   1. A translation is served only for its locale and only while the entry's
 *      current English text still hashes to the translation's source: an
 *      entry edited in a newer revision falls back to English.
 *   2. The write accepts only the current published revision of a live release
 *      with matching snapshot, entries and sources; any refusal writes nothing.
 */

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const actor = { principalType: "agent" as const, principalId: "agent-hasaki", clientId: "release-app" };
const SNAP1 = "1".repeat(64);
const SNAP2 = "2".repeat(64);

async function seedRelease(texts: string[]) {
  const db = getDb();
  const releaseId = crypto.randomUUID();
  const entryIds = texts.map(() => crypto.randomUUID());
  const version = `9.${Math.floor(Math.random() * 1e6)}.0`;
  await db.insert(releaseNotes).values({id: releaseId, releaseKey: `v:${version}`, version, tag: `v${version}`, date: "2026-10-01", currentRevision: 1});
  await db.insert(releaseNoteRevisions).values({releaseId, revision: 1, snapshotHash: SNAP1});
  await db.insert(releaseNoteRevisionItems).values(texts.map((text, ordinal) => ({
    releaseId, revision: 1, entryId: entryIds[ordinal]!, ordinal, type: "fix" as const, text, emphasis: false,
  })));
  return {releaseId, entryIds};
}

function submission(releaseId: string, entries: Array<{entryId: string; english: string; text: string}>, overrides: Record<string, unknown> = {}) {
  return {
    releaseId, revision: 1, snapshotHash: SNAP1, locale: "zh-cn", reason: "translate",
    entries: entries.map(e => ({entryId: e.entryId, sourceHash: releaseNoteSourceHash(e.english), text: e.text})),
    ...overrides,
  };
}

async function entriesFor(baseUrl: string, query: string) {
  const res = await fetch(`${baseUrl}/api/release-notes?limit=100${query}`);
  assert.equal(res.status, 200);
  const {items} = await res.json();
  return items.flatMap((item: {entries: unknown[]}) => item.entries) as Array<{entryId: string; text: string; translation?: {locale: string; text: string}}>;
}

test("translations are served per locale while the English is unchanged", async ({ app }) => {
  const db = getDb();
  const {releaseId, entryIds: [a, b]} = await seedRelease(["Old wording", "Stays the same"]);
  const result = await writeReleaseNoteTranslations(db, actor, submission(releaseId, [
    {entryId: a!, english: "Old wording", text: "旧的说法"},
    {entryId: b!, english: "Stays the same", text: "保持不变"},
  ]));
  assert.deepEqual(result, {ok: true, releaseId, revision: 1, locale: "zh-cn", written: 2});

  const zh = await entriesFor(app.baseUrl, "&locale=zh-cn");
  assert.deepEqual(zh.map(e => e.translation), [{locale: "zh-cn", text: "旧的说法"}, {locale: "zh-cn", text: "保持不变"}]);
  assert.deepEqual(zh.map(e => e.text), ["Old wording", "Stays the same"], "English text stays alongside");
  for (const query of ["", "&locale=en", "&locale=ja", "&locale=fr", "&locale=zh-Hant-TW", "&locale=ZH-CN"]) {
    const entries = await entriesFor(app.baseUrl, query);
    assert.equal(entries.some(e => e.translation), query === "&locale=ZH-CN", `locale query ${query || "(none)"}`);
  }
  const bad = await fetch(`${app.baseUrl}/api/release-notes?locale=%3Cscript%3E`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_locale");

  const detail = await (await fetch(`${app.baseUrl}/api/release-notes/${releaseId}?locale=zh-cn`)).json();
  assert.equal(detail.entries[0].translation.text, "旧的说法");

  // Revision 2 edits entry a and keeps entry b word for word.
  await db.insert(releaseNoteRevisions).values({releaseId, revision: 2, snapshotHash: SNAP2});
  await db.insert(releaseNoteRevisionItems).values([
    {releaseId, revision: 2, entryId: a!, ordinal: 0, type: "fix", text: "New wording", emphasis: false},
    {releaseId, revision: 2, entryId: b!, ordinal: 1, type: "fix", text: "Stays the same", emphasis: false},
  ]);
  await db.update(releaseNotes).set({currentRevision: 2}).where(eq(releaseNotes.id, releaseId));
  const afterEdit = await entriesFor(app.baseUrl, "&locale=zh-cn");
  assert.deepEqual(afterEdit.map(e => [e.text, e.translation?.text]), [["New wording", undefined], ["Stays the same", "保持不变"]]);

  const audit = await db.select().from(releaseNoteAudit).where(eq(releaseNoteAudit.releaseId, releaseId));
  assert.deepEqual(audit.map(r => [r.action, r.actorType, r.actorId, r.clientId, r.revision, r.entryDeltas]),
    [["translate:zh-cn", "agent", "agent-hasaki", "release-app", 1, []]]);
});

test("ids in upper case are accepted and stored lower case", async ({ app }) => {
  const db = getDb();
  const {releaseId, entryIds: [a]} = await seedRelease(["Case"]);
  const result = await writeReleaseNoteTranslations(db, actor,
    {...submission(releaseId.toUpperCase(), [{entryId: a!.toUpperCase(), english: "Case", text: "大小写"}]), locale: "zh-tw"});
  assert.deepEqual(result, {ok: true, releaseId, revision: 1, locale: "zh-tw", written: 1});
  assert.equal((await entriesFor(app.baseUrl, "&locale=zh-tw")).find(e => e.entryId === a)?.translation?.text, "大小写");
});

test("the function accepts exactly the display locales but English", async ({ db: fixture }) => {
  void fixture;
  const db = getDb();
  const {releaseId, entryIds: [a]} = await seedRelease(["Every language"]);
  for (const locale of DISPLAY_LOCALES) {
    const result = await writeReleaseNoteTranslations(db, actor,
      submission(releaseId, [{entryId: a!, english: "Every language", text: `in ${locale}`}], {locale}));
    assert.equal(result.ok, (RELEASE_NOTE_TRANSLATION_LOCALES as readonly string[]).includes(locale), `${locale}: ${JSON.stringify(result)}`);
  }
  const rows = await db.select().from(releaseNoteTranslations).where(eq(releaseNoteTranslations.releaseId, releaseId));
  assert.deepEqual(rows.map(r => r.locale).sort(), [...RELEASE_NOTE_TRANSLATION_LOCALES].sort());
});

test("a later submission replaces the translation", async ({ app }) => {
  const db = getDb();
  const {releaseId, entryIds: [a]} = await seedRelease(["Something"]);
  for (const text of ["初稿", "定稿"]) {
    const result = await writeReleaseNoteTranslations(db, actor, submission(releaseId, [{entryId: a!, english: "Something", text}], {locale: "ja"}));
    assert.equal(result.ok, true);
  }
  const rows = await db.select().from(releaseNoteTranslations).where(eq(releaseNoteTranslations.releaseId, releaseId));
  assert.deepEqual(rows.map(r => [r.locale, r.text]), [["ja", "定稿"]]);
  assert.equal((await entriesFor(app.baseUrl, "&locale=ja")).find(e => e.entryId === a)?.translation?.text, "定稿");
});

test("stale or mismatched submissions are refused and write nothing", async ({ db: fixture }) => {
  void fixture; // DB-only case: acquire the database without an app.
  const db = getDb();
  const {releaseId, entryIds: [a, b]} = await seedRelease(["First", "Second"]);
  const good = [{entryId: a!, english: "First", text: "第一"}];
  const refusals: Array<[string, unknown]> = [
    ["invalid_request", submission(releaseId, good, {locale: "en"})],
    ["invalid_request", submission(releaseId, good, {reason: ""})],
    ["invalid_request", submission(releaseId, good, {extra: true})],
    ["invalid_request", submission(releaseId, good, {revision: 1.5})],
    ["invalid_request", submission(releaseId, good, {releaseId: "not-a-uuid"})],
    ["invalid_request", {...submission(releaseId, good), entries: [{...submission(releaseId, good).entries[0], text: ""}]}],
    ["invalid_request", {...submission(releaseId, good), entries: [{...submission(releaseId, good).entries[0], note: "x"}]}],
    ["invalid_request", "not an object"],
    ["invalid_request", {...submission(releaseId, good), entries: [...submission(releaseId, good).entries, ...submission(releaseId, good).entries]}],
    ["release_not_found", submission(crypto.randomUUID(), good)],
    ["snapshot_mismatch", submission(releaseId, good, {snapshotHash: SNAP2})],
    ["unknown_entry", submission(releaseId, [{entryId: crypto.randomUUID(), english: "First", text: "第一"}])],
    ["source_changed", submission(releaseId, [...good, {entryId: b!, english: "Second, before an edit", text: "第二"}])],
  ];
  for (const [code, body] of refusals) {
    const result = await writeReleaseNoteTranslations(db, actor, body);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(!result.ok && result.code, code, JSON.stringify(result));
  }
  assert.deepEqual(await writeReleaseNoteTranslations(db, {...actor, principalId: " "}, submission(releaseId, good)),
    {ok: false, code: "invalid_request", message: "actorId and clientId are required"});
  // A NUL byte never reaches the function: Postgres refuses it in jsonb.
  await assert.rejects(writeReleaseNoteTranslations(db, actor, submission(releaseId, good, {reason: "has a \0 byte"})));

  await db.insert(releaseNoteRevisions).values({releaseId, revision: 2, snapshotHash: SNAP2});
  await db.update(releaseNotes).set({currentRevision: 2}).where(eq(releaseNotes.id, releaseId));
  assert.deepEqual(await writeReleaseNoteTranslations(db, actor, submission(releaseId, good)),
    {ok: false, code: "revision_not_current", currentRevision: 2});

  await db.update(releaseNotes).set({retractedAt: new Date()}).where(eq(releaseNotes.id, releaseId));
  assert.deepEqual(await writeReleaseNoteTranslations(db, actor, submission(releaseId, good, {revision: 2, snapshotHash: SNAP2})),
    {ok: false, code: "release_retracted"});

  const draftOnly = crypto.randomUUID();
  await db.insert(releaseNotes).values({id: draftOnly, releaseKey: `v:draft-${draftOnly}`, date: "2026-10-02"});
  await db.insert(releaseNoteDrafts).values({releaseId: draftOnly, entries: []});
  assert.deepEqual(await writeReleaseNoteTranslations(db, actor, submission(draftOnly, good)), {ok: false, code: "release_not_published"});

  assert.deepEqual(await db.select().from(releaseNoteTranslations).where(eq(releaseNoteTranslations.releaseId, releaseId)), []);
  assert.deepEqual(await db.select().from(releaseNoteAudit).where(and(eq(releaseNoteAudit.releaseId, releaseId))), []);
});
