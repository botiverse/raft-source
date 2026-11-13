import type { ArtifactCard, ArtifactDeletedReference, ArtifactFacts, ArtifactKind, ArtifactShownActor } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";

import { formatRelativeTime } from "../../utils/relativeTime";

type IntlLike = Pick<IntlShape, "formatMessage" | "formatNumber">;

/**
 * The file type as people know it, as the badge on a card's file glyph says
 * it (ArtifactMessageCard) and, where there is no glyph, the hover card of an
 * Artifact link in a message's text. Not a word for the kind: `other` has none.
 */
export const ARTIFACT_KIND_BADGE: Record<ArtifactKind, string | null> = {
  html: "HTML",
  markdown: "MD",
  text: "TXT",
  csv: "CSV",
  image: "IMG",
  pdf: "PDF",
  video: "VIDEO",
  other: null,
};

/** A page file's extension at the end of a title: `.md`, `.markdown`, `.html`, `.htm`, any case. */
const PAGE_FILE_SUFFIX = /\.(?:md|markdown|html?)$/i;

/**
 * The title the home page's cards show (#proj-workspace:#177): without a
 * trailing `.md`, `.markdown`, `.html` or `.htm`, which an Artifact saved from
 * an attachment kept before saves dropped it (shared artifactTitleFromFileName);
 * so `hello.md` reads `hello`. Shown only: the title itself stays as it is
 * (search, rename, the viewer). Trimmed first, so `notes.md ` reads `notes`
 * too (#proj-workspace:#187). Any other title as it is, and never empty
 * (`.md` stays `.md`).
 */
export function artifactShownTitle(title: string): string {
  const trimmed = title.trim();
  const bare = trimmed.replace(PAGE_FILE_SUFFIX, "").trim();
  return bare || trimmed || title;
}

/** A size in B, KB or MB, its number in the reader's locale (formatNumber: "1,5 MB" in ru): the cards' facts, the Files panel (#239). */
export function formatBytes(bytes: number, { formatMessage, formatNumber }: IntlLike): string {
  if (bytes < 1024) return formatMessage({ id: "artifacts.facts.bytes" }, { value: formatNumber(bytes) });
  if (bytes < 1024 * 1024) return formatMessage({ id: "artifacts.facts.kilobytes" }, { value: formatNumber(Math.round(bytes / 1024)) });
  return formatMessage({ id: "artifacts.facts.megabytes" }, { value: formatNumber(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
}

/**
 * The fact line under a card's title, formatted from the server's raw counts:
 * "6 pages", "5 rows × 4 columns · Channel, September", "1600 × 1000",
 * "214 lines". It never names the kind (the file glyph and its badge do, as
 * an attachment's summary does). HTML and Markdown have none: their
 * description is the line. When nothing better is known, the size.
 */
export function formatArtifactFacts(kind: ArtifactKind, facts: ArtifactFacts, intl: IntlLike): string | null {
  const { formatMessage } = intl;
  if (kind === "html" || kind === "markdown") return null;
  const parts: string[] = [];
  if (kind === "text" && facts.lines != null) {
    parts.push(formatMessage({ id: "artifacts.facts.lines" }, { count: facts.lines }));
  }
  if (kind === "csv" && facts.rows != null) {
    parts.push(facts.columns != null
      ? formatMessage({ id: "artifacts.facts.rowsColumns" }, { rows: facts.rows, columns: facts.columns })
      : formatMessage({ id: "artifacts.facts.rows" }, { count: facts.rows }));
  }
  if (kind === "csv" && facts.columnNames?.length) {
    // A pair message, not Intl.ListFormat: its "unit" lists join Chinese with
    // no separator at all ("ABC"); the catalog says "、" / ", ".
    parts.push(facts.columnNames.reduce((list, name) => formatMessage({ id: "artifacts.facts.columnPair" }, { list, name })));
  }
  if (kind === "image" && facts.width && facts.height) {
    parts.push(formatMessage({ id: "artifacts.facts.pixels" }, { width: facts.width, height: facts.height }));
  }
  if (kind === "pdf" && facts.pages != null) {
    parts.push(formatMessage({ id: "artifacts.facts.pages" }, { count: facts.pages }));
  }
  if (parts.length === 0) parts.push(formatBytes(facts.sizeBytes, intl));
  return parts.join(" · ");
}

/**
 * The name a card's author, a version's publisher or a comment's author is
 * shown by: the display name, or for one no one stands behind any more
 * (ArtifactActor.gone) "Deleted agent", "Deleted user" or, Raft's own,
 * "System", never an empty name (xxchan).
 */
export function artifactActorName(actor: Pick<ArtifactShownActor, "type" | "displayName" | "gone">, formatMessage: IntlShape["formatMessage"]): string {
  if (actor.gone === "system") return formatMessage({ id: "artifacts.actor.system" });
  if (actor.gone === "deleted") return formatMessage({ id: actor.type === "agent" ? "artifacts.actor.deletedAgent" : "artifacts.actor.deletedUser" });
  return actor.displayName;
}

/** Who updated it and when: "Martin updated 2 hours ago"; the name alone without a valid time. */
export function formatArtifactUpdated(card: ArtifactCard, intl: Pick<IntlShape, "formatMessage" | "locale">): string {
  const time = formatRelativeTime(card.updatedAt, intl.locale);
  const name = artifactActorName(card.author, intl.formatMessage);
  return time ? intl.formatMessage({ id: "artifacts.card.updatedBy" }, { name, time }) : name;
}

/** What the card and the chip show of a deleted Artifact (ArtifactDeletedReference), read once by artifactDeletedOf. */
export interface ArtifactDeletedShown {
  title: string;
  /** Who deleted it, by the name shown (display name, else handle); null when the answer names no one. */
  deletedBy: string | null;
  /** ISO 8601, as sent; null when missing. */
  deletedAt: string | null;
}

/**
 * A deleted reference, as the server sent it (`deleted` of a summaries
 * answer, or an ArtifactReference from a stand-in source), read into what
 * the card and chip draw; null without a title, which is then drawn as
 * `unavailable` (a half answer would otherwise be an empty card). Who and
 * when may be missing: the card then says less.
 */
export function artifactDeletedOf(answer: unknown): ArtifactDeletedShown | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { title, deletedBy, deletedAt } = answer as Partial<Record<keyof ArtifactDeletedReference, unknown>>;
  if (typeof title !== "string" || title.trim() === "") return null;
  return { title, deletedBy: shownName(deletedBy), deletedAt: typeof deletedAt === "string" ? deletedAt : null };
}

function shownName(actor: unknown): string | null {
  if (typeof actor !== "object" || actor === null) return null;
  const { displayName, name } = actor as Partial<Record<"displayName" | "name", unknown>>;
  return [displayName, name].find((value): value is string => typeof value === "string" && value.trim() !== "") ?? null;
}

/**
 * Who deleted it and when: "Deleted by <name> <time>", with what is known
 * ("Deleted by <name>", "Deleted <time>", "Deleted").
 */
export function formatArtifactDeleted(deleted: ArtifactDeletedShown, intl: Pick<IntlShape, "formatMessage" | "locale">): string {
  const name = deleted.deletedBy;
  const time = formatRelativeTime(deleted.deletedAt, intl.locale);
  if (name && time) return intl.formatMessage({ id: "artifacts.card.deletedBy" }, { name, time });
  if (name) return intl.formatMessage({ id: "artifacts.card.deletedByName" }, { name });
  if (time) return intl.formatMessage({ id: "artifacts.card.deletedAt" }, { time });
  return intl.formatMessage({ id: "artifacts.card.deleted" });
}
