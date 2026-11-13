import { createHash } from 'node:crypto';
import { Router, type Router as ExpressRouter } from 'express';
import { and, asc, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../db/index';
import { releaseNotes, releaseNoteRevisions, releaseNoteRevisionItems } from '../db/schema';
import {
  isReleaseNoteTranslationLocale, loadCurrentReleaseNoteTranslations, type ReleaseNoteTranslationLocale,
} from '../services/releaseNoteTranslations';

/**
 * `?locale=` asks for translations: a display locale gets each entry's current
 * translation as `translation: {locale, text}` next to the English `text`; `en`,
 * an absent parameter or a well-formed tag without translations gets English only.
 */
function parseLocale(raw: unknown): {ok: true; locale: ReleaseNoteTranslationLocale | null} | {ok: false} {
  if (raw === undefined) return {ok: true, locale: null};
  if (typeof raw !== 'string' || raw.length > 35 || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(raw)) return {ok: false};
  const locale = raw.toLowerCase();
  return {ok: true, locale: isReleaseNoteTranslationLocale(locale) ? locale : null};
}

type PublicEntry = {entryId: string; text: string};
async function withTranslations<E extends PublicEntry>(
  db: ReturnType<typeof getDb>, locale: ReleaseNoteTranslationLocale | null,
  releases: Array<{releaseId: string; entries: E[]}>,
): Promise<Map<string, Array<E & {translation?: {locale: string; text: string}}>>> {
  const out = new Map<string, Array<E & {translation?: {locale: string; text: string}}>>();
  const translations = locale ? await loadCurrentReleaseNoteTranslations(db, locale,
    releases.flatMap(r => r.entries.map(e => ({releaseId: r.releaseId, entryId: e.entryId, text: e.text})))) : new Map<string, string>();
  for (const {releaseId, entries} of releases) {
    out.set(releaseId, entries.map(entry => {
      const text = translations.get(`${releaseId}:${entry.entryId}`);
      return text !== undefined && locale ? {...entry, translation: {locale, text}} : entry;
    }));
  }
  return out;
}

export const releaseNotesRouter: ExpressRouter = Router();
// Revision 1's publication time never changes, so it orders releases that share a
// date (newest first) without moving them when a later revision is published.
// Ordering those by the random id put an older release first on the list.
const firstRevision = alias(releaseNoteRevisions, 'first_revision');
releaseNotesRouter.get('/', async (req, res, next) => {
  try {
    const localeParam = parseLocale(req.query.locale);
    if (!localeParam.ok) { res.status(400).json({code: 'invalid_locale'}); return; }
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({code: 'invalid_limit'}); return;
    }
    let after: {date: string; first: string; id: string} | undefined;
    if (req.query.cursor !== undefined) {
      try {
        if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 256) throw new Error();
        after = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'));
        if (!after || !/^\d{4}-\d{2}-\d{2}$/.test(after.date) || !/^[0-9a-f-]{36}$/.test(after.id)
          || typeof after.first !== 'string' || Number.isNaN(Date.parse(after.first))) throw new Error();
      } catch { res.status(400).json({code: 'invalid_cursor'}); return; }
    }
    // Microsecond ISO text, so the cursor compares exactly (a JS Date would drop to ms).
    const firstPublishedAt = sql<string>`to_char(${firstRevision.publishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const db = getDb();
    const rows = await db.select({
      releaseId: releaseNotes.id, releaseKey: releaseNotes.releaseKey,
      version: releaseNotes.version, tag: releaseNotes.tag, date: releaseNotes.date,
      revision: releaseNoteRevisions.revision, snapshotHash: releaseNoteRevisions.snapshotHash,
      publishedAt: releaseNoteRevisions.publishedAt, retractedAt: releaseNotes.retractedAt,
      firstPublishedAt,
    }).from(releaseNotes).innerJoin(releaseNoteRevisions, and(
      eq(releaseNotes.id, releaseNoteRevisions.releaseId),
      eq(releaseNotes.currentRevision, releaseNoteRevisions.revision),
    )).innerJoin(firstRevision, and(eq(releaseNotes.id, firstRevision.releaseId), eq(firstRevision.revision, 1)))
      .where(and(isNotNull(releaseNotes.currentRevision), after
        ? sql`(${releaseNotes.date}, ${firstRevision.publishedAt}, ${releaseNotes.id}) < (${after.date}::date, ${after.first}::timestamptz, ${after.id}::uuid)`
        : undefined))
      .orderBy(desc(releaseNotes.date), desc(firstRevision.publishedAt), desc(releaseNotes.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    // One query for the whole page, current revisions only. A query per release
    // fanned out up to `limit` parallel connection acquisitions on every cache miss.
    const liveRevision = new Map(page.filter(row => !row.retractedAt).map(row => [row.releaseId, row.revision]));
    const itemRows = liveRevision.size === 0 ? [] : await db.select({releaseId: releaseNoteRevisionItems.releaseId,
      revision: releaseNoteRevisionItems.revision, entryId: releaseNoteRevisionItems.entryId,
      type: releaseNoteRevisionItems.type, text: releaseNoteRevisionItems.text,
      emphasis: releaseNoteRevisionItems.emphasis, ordinal: releaseNoteRevisionItems.ordinal,
    }).from(releaseNoteRevisionItems).where(or(...[...liveRevision].map(([releaseId, revision]) => and(
      eq(releaseNoteRevisionItems.releaseId, releaseId), eq(releaseNoteRevisionItems.revision, revision)))))
      .orderBy(asc(releaseNoteRevisionItems.releaseId), asc(releaseNoteRevisionItems.ordinal));
    const entriesByRelease = new Map<string, Array<{entryId: string; type: typeof itemRows[number]['type']; text: string; emphasis: boolean; ordinal: number}>>();
    for (const {releaseId, revision, ...entry} of itemRows) {
      if (liveRevision.get(releaseId) !== revision) continue;
      const list = entriesByRelease.get(releaseId);
      if (list) list.push(entry); else entriesByRelease.set(releaseId, [entry]);
    }
    const localized = await withTranslations(db, localeParam.locale,
      [...entriesByRelease].map(([releaseId, entries]) => ({releaseId, entries})));
    const items = page.map(row => {
      const {retractedAt, firstPublishedAt: _first, ...publicRow} = row;
      return {...publicRow, state: retractedAt ? 'retracted' : 'published', entries: retractedAt ? [] : localized.get(row.releaseId) ?? []};
    });
    const last = page.at(-1);
    const body = {items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({date:last.date,first:last.firstPublishedAt,id:last.releaseId})).toString('base64url') : null};
    const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('hex') + '"';
    res.set('ETag',etag).set('Cache-Control','public, max-age=30');
    if (req.headers['if-none-match'] === etag) {res.status(304).end(); return;}
    res.json(body);
  } catch (err) { next(err); }
});

// Public detail by release id: published entries, or a retracted stub without entries.
releaseNotesRouter.get('/:releaseId', async (req, res, next) => {
  try {
    const localeParam = parseLocale(req.query.locale);
    if (!localeParam.ok) { res.status(400).json({code: 'invalid_locale'}); return; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.releaseId)) {
      res.status(400).json({code: 'invalid_release_id'}); return;
    }
    const db = getDb();
    const [row] = await db.select({
      releaseId: releaseNotes.id, releaseKey: releaseNotes.releaseKey,
      version: releaseNotes.version, tag: releaseNotes.tag, date: releaseNotes.date,
      revision: releaseNoteRevisions.revision, snapshotHash: releaseNoteRevisions.snapshotHash,
      publishedAt: releaseNoteRevisions.publishedAt, retractedAt: releaseNotes.retractedAt,
    }).from(releaseNotes).innerJoin(releaseNoteRevisions, and(
      eq(releaseNotes.id, releaseNoteRevisions.releaseId),
      eq(releaseNotes.currentRevision, releaseNoteRevisions.revision),
    )).where(and(eq(releaseNotes.id, req.params.releaseId), isNotNull(releaseNotes.currentRevision))).limit(1);
    if (!row) { res.status(404).json({code: 'not_found'}); return; }
    const {retractedAt, ...publicRow} = row;
    const entries = retractedAt ? [] : await db.select({entryId: releaseNoteRevisionItems.entryId,
      type: releaseNoteRevisionItems.type, text: releaseNoteRevisionItems.text,
      emphasis: releaseNoteRevisionItems.emphasis, ordinal: releaseNoteRevisionItems.ordinal,
    }).from(releaseNoteRevisionItems).where(and(eq(releaseNoteRevisionItems.releaseId, row.releaseId),
      eq(releaseNoteRevisionItems.revision, row.revision))).orderBy(releaseNoteRevisionItems.ordinal);
    const localized = await withTranslations(db, localeParam.locale, [{releaseId: row.releaseId, entries}]);
    const body = {...publicRow, state: retractedAt ? 'retracted' : 'published', entries: localized.get(row.releaseId) ?? []};
    const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('hex') + '"';
    res.set('ETag', etag).set('Cache-Control', 'public, max-age=30');
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.json(body);
  } catch (err) { next(err); }
});
