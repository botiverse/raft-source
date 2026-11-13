// What an agent reads when Artifacts tells it something (S1c): one line, at
// most 500 characters, so the Server can use it as a system.artifacts
// notification's summary as it stands, and a client can render the same words
// from the message's `app_event` (artifactAgentNotice.ts). Every notice says why it
// came, what to do, that no reply is needed when nothing is asked, and how to
// stop it (Sage's notices spec, #proj-workspace).
//
// Next steps go through RAFT_HINTS: CLI commands, or tool calls for cloud
// agents. They are never cut: to fit the limit the comment's excerpt shrinks
// first, then the title and the place, and only then the line itself.

import { formatHint, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";
import { foldAgentOneLineText } from "../agentMessageText";
import type { AgentApiArtifactActor } from "../agentApiArtifactsContract";
import type { ArtifactAgentNotice } from "../artifactAgentNotice";
import { artifactAnchorView } from "./artifactAnchors";

/** The Server's limit for a notification summary. */
export const ARTIFACT_NOTICE_MAX_CHARS = 500;
/** An excerpt is shortened to this before titles and places are. */
const MIN_EXCERPT_CHARS = 40;
/** Titles, places and file lists are shortened to this when the line is still too long. */
const SHORT_NAME_CHARS = 40;
/** Files of yours named before "and N more". */
const FILES_NAMED = 3;

function actor(a: AgentApiArtifactActor): string {
  return a.name ? `@${a.name}` : `(a deleted ${a.type === "agent" ? "agent" : "user"})`;
}

// The notice is one line: titles, places and excerpts are all folded (any line separator, not only `\s`).
const oneLine = foldAgentOneLineText;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? "…" : `${text.slice(0, max - 1)}…`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Parts {
  title: string;
  where: string;
  excerpt: string;
}

/**
 * Build the line, shrinking what can shrink until it fits: the excerpt (to
 * MIN_EXCERPT_CHARS), then the title and the place, then the excerpt
 * entirely; next steps are never shortened, and a hard cut is the last resort.
 */
function fitLine(build: (p: Parts) => string, full: Parts): string {
  const max = ARTIFACT_NOTICE_MAX_CHARS;
  let parts = { ...full, title: oneLine(full.title), where: oneLine(full.where), excerpt: oneLine(full.excerpt) };
  let line = build(parts);
  if (line.length <= max) return line;
  parts = { ...parts, excerpt: clip(parts.excerpt, Math.max(MIN_EXCERPT_CHARS, parts.excerpt.length - (line.length - max))) };
  line = build(parts);
  if (line.length <= max) return line;
  parts = { ...parts, title: clip(parts.title, SHORT_NAME_CHARS), where: clip(parts.where, SHORT_NAME_CHARS) };
  line = build(parts);
  if (line.length <= max) return line;
  const room = parts.excerpt.length - (line.length - max);
  parts = { ...parts, excerpt: room >= 10 ? clip(parts.excerpt, room) : "" };
  line = build(parts);
  return line.length <= max ? line : clip(line, max);
}

/**
 * A comment's images, counted (an excerpt's `imageCount`): `(+2 images)`
 * after its text, `(1 image)` for a comment of images alone. Nothing for none.
 */
export function formatCommentImageCount(count: number | undefined, withText: boolean): string {
  if (count === undefined || count <= 0) return "";
  return withText ? `(+${plural(count, "image", "images")})` : `(${plural(count, "image", "images")})`;
}

/**
 * `: "excerpt"`, then its images counted (`: "looks off" (+2 images)`;
 * images alone: `: (2 images)`). An excerpt fitLine had to drop leaves its
 * count (`(+2 images)`). The count is built into the line, so fitLine shrinks
 * the text around it and never cuts it.
 */
function quoted(excerpt: string, images?: { count: number | undefined; withText: boolean }): string {
  const count = formatCommentImageCount(images?.count, images?.withText ?? true);
  if (excerpt) return count ? `: "${excerpt}" ${count}` : `: "${excerpt}"`;
  if (!count) return "";
  return images?.withText ? ` ${count}` : `: ${count}`;
}

/**
 * Said with the answer command: the CLI takes the comment's text on stdin,
 * which the command alone doesn't show (copied as is, it fails once); a tool
 * call already names its `body`.
 */
export function commentOnStdin(style: RaftHintStyle): string {
  return style === "cli" ? " (comment on stdin)" : "";
}

/** Why the agent follows the Artifact, as a clause. */
function followingClause(notice: ArtifactAgentNotice): string {
  const f = notice.following;
  if (!f) return "";
  if (f.kind === "published") return f.version === null ? "you follow it because you pushed it" : `you follow it because you pushed v${f.version}`;
  if (f.kind === "commented") return "you follow it because you commented";
  return "you follow it";
}

/**
 * A review (S8): one line for all its comments, which the agent reads with
 * one command; a mention is answered on its own comment. The Server writes
 * this line once for every recipient's CLI, so it names only commands every
 * Artifacts CLI has: the new comments list, not `comments --review`.
 */
function formatReviewNotice(notice: ArtifactAgentNotice, review: NonNullable<ArtifactAgentNotice["review"]>, style: RaftHintStyle, stop: string): string {
  const a = notice.artifact;
  const read = formatHint(RAFT_HINTS.artifactComments({ artifact: a.id }), style);
  // The summary is the reviewer's, set apart so it doesn't read as the mention.
  const summary = (excerpt: string) => (excerpt ? `. Summary: "${excerpt}"` : "");
  const on = review.fileCount > 0 ? ` on ${plural(review.fileCount, "file", "files")}` : " on the whole artifact";
  const what = `${plural(review.commentCount, "comment", "comments")}${on}`;
  const them = review.commentCount === 1 ? "it" : "them";
  if (notice.reason === "mentioned") {
    const answer = formatHint(RAFT_HINTS.artifactComment({ artifact: a.id, replyTo: "<comment>" }), style);
    const you = review.mentionsYou > 1 ? `; you're mentioned ${review.mentionsYou} times` : review.mentionsYou === 1 ? "; you're mentioned once" : "";
    return fitLine(
      (p) => `${actor(review.author)} reviewed "${p.title}" (v${review.version}): ${what}${you}${summary(p.excerpt)}. Read ${them}: ${read}. If one asks something of you, answer it in the artifact${commentOnStdin(style)}: ${answer}. If it needs nothing from you, no reply is needed.`,
      { title: a.title, where: "", excerpt: review.summaryExcerpt ?? "" },
    );
  }
  const why = followingClause(notice);
  return fitLine(
    (p) => `${actor(review.author)} reviewed "${p.title}" (v${review.version}${why ? `; ${why}` : ""}): ${what}${summary(p.excerpt)}. Read ${them}: ${read}. If ${review.commentCount === 1 ? "it needs" : "they need"} nothing from you, no reply is needed.${stop}`,
    { title: a.title, where: "", excerpt: review.summaryExcerpt ?? "" },
  );
}

/**
 * A rename (task #147): who renamed it, from what to what, and the id it
 * keeps, so an agent that knew it by its old title (which finds it no more)
 * reads it by its id.
 */
function formatRenameNotice(notice: ArtifactAgentNotice, renamed: NonNullable<ArtifactAgentNotice["renamed"]>, style: RaftHintStyle, stop: string): string {
  const read = formatHint(RAFT_HINTS.artifactRead({ artifact: notice.artifact.id }), style);
  const why = followingClause(notice);
  return fitLine(
    (p) => `${actor(renamed.by)} renamed "${p.where}" to "${p.title}"${why ? ` (${why})` : ""}. Its id is unchanged: ${read}. No reply is needed.${stop}`,
    { title: renamed.to, where: renamed.from, excerpt: "" },
  );
}

/**
 * A resolve (#249): who resolved the agent's thread, which one, the note's
 * start, and how to reopen it (a reply reopens it too). It is about the
 * agent's own comment, sent whether it follows or not: no "stop" clause.
 */
function formatResolvedNotice(notice: ArtifactAgentNotice, resolved: NonNullable<ArtifactAgentNotice["resolved"]>, style: RaftHintStyle): string {
  const a = notice.artifact;
  const c = resolved.comment;
  const reopen = formatHint(RAFT_HINTS.artifactReopen({ artifact: a.id, comment: c.id }), style);
  const tail = `If it isn't done, reply in it or reopen it: ${reopen}. Otherwise no reply is needed.`;
  const where = c.path ?? "the whole artifact";
  // With a note, the note is what's quoted (it says what answered the comment); without, the comment itself.
  if (resolved.noteExcerpt) {
    return fitLine(
      (p) => `${actor(resolved.by)} resolved your comment on "${p.title}" (${p.where})${p.excerpt ? `, noting: "${p.excerpt}"` : ""}. ${tail}`,
      { title: a.title, where, excerpt: resolved.noteExcerpt },
    );
  }
  return fitLine(
    (p) => `${actor(resolved.by)} resolved your comment on "${p.title}" (${p.where})${p.excerpt ? `: "${p.excerpt}"` : ""}. ${tail}`,
    { title: a.title, where, excerpt: c.excerpt },
  );
}

/**
 * A channel's announcement got a new version (#proj-chat:#29): which channel,
 * who pushed which version (and its note), and how to read it. It comes from
 * being in the channel, not from following the Artifact: no "stop" clause.
 */
function formatChannelAnnouncementNotice(notice: ArtifactAgentNotice, channelAnnouncement: NonNullable<ArtifactAgentNotice["channelAnnouncement"]>, style: RaftHintStyle): string {
  const read = formatHint(RAFT_HINTS.artifactRead({ artifact: notice.artifact.id }), style);
  return fitLine(
    (p) => `${actor(channelAnnouncement.publisher)} updated the announcement of ${p.where} ("${p.title}", now v${channelAnnouncement.number})${p.excerpt ? ` — "${p.excerpt}"` : ""}. Read it before you next work there: ${read}. No reply is needed.`,
    { title: notice.artifact.title, where: channelAnnouncement.channel, excerpt: channelAnnouncement.note ?? "" },
  );
}

/** One notice line; the Server's summary in step 1, a client's rendering of `app_event` in step 2. */
export function formatArtifactNotice(notice: ArtifactAgentNotice, style: RaftHintStyle = "cli"): string {
  const a = notice.artifact;
  const stop = ` To stop these: ${formatHint(RAFT_HINTS.artifactUnfollow({ artifact: a.id }), style)}`;

  if (notice.reason === "your_file_changed" && notice.version) {
    const v = notice.version;
    const named = v.yourFiles.slice(0, FILES_NAMED).join(", ");
    const files = v.yourFiles.length > FILES_NAMED ? `${named} and ${v.yourFiles.length - FILES_NAMED} more` : named;
    const read = formatHint(RAFT_HINTS.artifactRead({ artifact: a.id }), style);
    return fitLine(
      (p) => `${actor(v.publisher)} pushed v${v.number} of "${p.title}", changing ${p.where}, which you last pushed in v${v.yourVersion}${p.excerpt ? ` — "${p.excerpt}"` : ""}. If your work depends on ${v.yourFiles.length === 1 ? "it" : "them"}, read it: ${read}. Otherwise no reply is needed.${stop}`,
      { title: a.title, where: files, excerpt: v.note ?? "" },
    );
  }

  if (notice.channelAnnouncement) return formatChannelAnnouncementNotice(notice, notice.channelAnnouncement, style);
  if (notice.review) return formatReviewNotice(notice, notice.review, style, stop);
  if (notice.renamed) return formatRenameNotice(notice, notice.renamed, style, stop);
  if (notice.resolved) return formatResolvedNotice(notice, notice.resolved, style);

  const comments = notice.comments;
  if (!comments) return clip(`Something changed in "${oneLine(a.title)}": ${formatHint(RAFT_HINTS.artifactRead({ artifact: a.id }), style)}`, ARTIFACT_NOTICE_MAX_CHARS);
  const latest = comments.latest[comments.latest.length - 1]!;
  // A reply lands on its parent's file and place, so the command needs no --path.
  const answer = formatHint(RAFT_HINTS.artifactComment({ artifact: a.id, replyTo: latest.id }), style);
  // The file, then the place in it in Raft's words (`a.html · lines 3-5`, `a.html · element <h2>`); its quoted text is the comment list's.
  const place = latest.path ? artifactAnchorView(latest.anchor, { withSelector: false })?.where : null;
  const full = { title: a.title, where: latest.path ? (place ? `${latest.path} · ${place}` : latest.path) : "the whole artifact", excerpt: latest.excerpt };
  // Counted from the comment itself, so a text fitLine dropped still reads as text (`(+2 images)`), not as images alone.
  const images = { count: latest.imageCount, withText: oneLine(latest.excerpt).trim() !== "" };

  if (notice.reason === "mentioned") {
    return fitLine(
      (p) => `${actor(latest.author)} mentioned you in a comment on "${p.title}" (${p.where})${quoted(p.excerpt, images)}. If it asks something of you, answer in the artifact${commentOnStdin(style)}: ${answer}. If it needs nothing from you, no reply is needed.`,
      full,
    );
  }
  const why = followingClause(notice);
  if (comments.count === 1) {
    return fitLine(
      (p) => `New comment by ${actor(latest.author)} on "${p.title}" (${p.where}${why ? `; ${why}` : ""})${quoted(p.excerpt, images)}. To answer${commentOnStdin(style)}: ${answer}. If it needs nothing from you, no reply is needed.${stop}`,
      full,
    );
  }
  const readAll = formatHint(RAFT_HINTS.artifactComments({ artifact: a.id }), style);
  return fitLine(
    (p) => `${plural(comments.count, "new comment", "new comments")} on "${p.title}"${why ? ` (${why})` : ""}, the latest by ${actor(latest.author)} on ${p.where}${quoted(p.excerpt, images)}. Read them: ${readAll}. If they need nothing from you, no reply is needed.${stop}`,
    full,
  );
}
