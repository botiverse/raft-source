import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DISPLAY_LOCALES, type DisplayLocale } from '@botiverse/raft-shared';
import { getDb } from '../db/index';
import { releaseNoteTranslations } from '../db/schema';
import type { Actor } from './releaseNotesMutation';

/**
 * Translations of published release notes into the app's display locales.
 *
 * The English notes keep their own draft/approval/publication workflow in the
 * Release App. Translations are written afterwards, per release and locale,
 * against the revision that is current at that moment, through one database
 * function, `public.release_note_translations_write` (migration
 * `release_note_translations`): the Release App calls it from its own
 * repository and this module wraps it, so the checks exist once. The public
 * read attaches a translation only while the entry's English text still hashes
 * to the translation's `sourceHash`.
 */

/** Every display locale but English; the database function and table check list the same six. */
export const RELEASE_NOTE_TRANSLATION_LOCALES = DISPLAY_LOCALES.filter(
  (locale): locale is Exclude<DisplayLocale, 'en'> => locale !== 'en',
);
export type ReleaseNoteTranslationLocale = (typeof RELEASE_NOTE_TRANSLATION_LOCALES)[number];

export function isReleaseNoteTranslationLocale(value: unknown): value is ReleaseNoteTranslationLocale {
  return typeof value === 'string' && (RELEASE_NOTE_TRANSLATION_LOCALES as readonly string[]).includes(value);
}

/** sha256 (hex) of an entry's English text: what a translation records as `sourceHash`. */
export function releaseNoteSourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One submission: entries of one published release, in one locale. */
export interface ReleaseNoteTranslationSubmission {
  releaseId: string;
  revision: number;
  snapshotHash: string;
  locale: ReleaseNoteTranslationLocale;
  reason: string;
  entries: Array<{entryId: string; sourceHash: string; text: string}>;
}

export type ReleaseNoteTranslationError =
  /** The body or actor is malformed; `message` says which field. */
  | {ok: false; code: 'invalid_request'; message: string}
  | {ok: false; code: 'release_not_found'}
  /** Only drafts exist: there is nothing public to translate yet. */
  | {ok: false; code: 'release_not_published'}
  | {ok: false; code: 'release_retracted'}
  /** A newer revision was published since the translation was prepared; `currentRevision` is it. */
  | {ok: false; code: 'revision_not_current'; currentRevision: number}
  | {ok: false; code: 'snapshot_mismatch'}
  /** These entryIds are not in the current revision. */
  | {ok: false; code: 'unknown_entry'; entryIds: string[]}
  /** These entries' English changed since the translation was prepared. */
  | {ok: false; code: 'source_changed'; entryIds: string[]};

export type ReleaseNoteTranslationResult =
  | {ok: true; releaseId: string; revision: number; locale: ReleaseNoteTranslationLocale; written: number}
  | ReleaseNoteTranslationError;

/**
 * Calls `public.release_note_translations_write`: validates the submission
 * against the release's current published revision and upserts its
 * translations with one `release_note_audit` row, all or nothing.
 */
export async function writeReleaseNoteTranslations(
  db: ReturnType<typeof getDb>,
  actor: Actor,
  body: ReleaseNoteTranslationSubmission | unknown,
): Promise<ReleaseNoteTranslationResult> {
  const result = await db.execute(sql`select public.release_note_translations_write(
    ${actor.principalType}, ${actor.principalId}, ${actor.clientId}, ${JSON.stringify(body ?? null)}::jsonb) as result`);
  return (result.rows[0] as {result: ReleaseNoteTranslationResult}).result;
}

/**
 * The translations in `locale` of `entries` (current-revision items) whose
 * source still matches, keyed `${releaseId}:${entryId}`. One query per page.
 */
export async function loadCurrentReleaseNoteTranslations(
  db: ReturnType<typeof getDb>,
  locale: ReleaseNoteTranslationLocale,
  entries: ReadonlyArray<{releaseId: string; entryId: string; text: string}>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entries.length === 0) return out;
  const releaseIds = [...new Set(entries.map(e => e.releaseId))];
  const rows = await db.select({releaseId: releaseNoteTranslations.releaseId, entryId: releaseNoteTranslations.entryId,
    sourceHash: releaseNoteTranslations.sourceHash, text: releaseNoteTranslations.text})
    .from(releaseNoteTranslations)
    .where(and(eq(releaseNoteTranslations.locale, locale), inArray(releaseNoteTranslations.releaseId, releaseIds)));
  const byKey = new Map(rows.map(row => [`${row.releaseId}:${row.entryId}`, row]));
  for (const entry of entries) {
    const row = byKey.get(`${entry.releaseId}:${entry.entryId}`);
    if (row && row.sourceHash === releaseNoteSourceHash(entry.text)) out.set(`${entry.releaseId}:${entry.entryId}`, row.text);
  }
  return out;
}
