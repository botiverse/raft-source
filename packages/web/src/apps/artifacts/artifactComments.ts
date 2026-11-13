// Comments on an Artifact (S4), the parts with no React in them: threads and
// their groups, the comment box's text and its @mentions as body parts, and
// who a comment will notify.
import type {
  ArtifactActor,
  ArtifactCapabilities,
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentId,
  ArtifactCommentPart,
  ArtifactFile,
  ArtifactWebCommentInput,
  ArtifactWillNotify,
} from "@botiverse/raft-shared";

import type { ArtifactViewerActor } from "./artifactApi";

export const actorKey = (actor: { type: string; id: string }): string => `${actor.type}:${actor.id}`;

/**
 * A comment and its replies, oldest first. `root` is null while the comment
 * a reply answers is on a page not loaded yet (or, once everything is loaded,
 * gone): the list shows a placeholder in its place. `first` is the root, or
 * else the first reply: where the thread is and when it started.
 */
export interface ArtifactCommentThread {
  id: ArtifactCommentId;
  root: ArtifactComment | null;
  replies: ArtifactComment[];
  first: ArtifactComment;
}

/**
 * Threads, in the order of their first comment (oldest first, E12). A reply
 * goes under the root of the thread it answers, at any depth. A reply whose
 * parent isn't here goes under a placeholder for it while older pages may
 * still hold it (`parentsMayBeOlder`); when they load, it moves under its
 * parent. With every page loaded, it stands as a thread of its own.
 */
export function buildThreads(comments: readonly ArtifactComment[], { parentsMayBeOlder = false } = {}): ArtifactCommentThread[] {
  const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byId = new Map(ordered.map((c) => [c.id, c]));
  /** The thread's id: its root's, or the missing comment's the chain stops at. */
  const rootIdOf = (comment: ArtifactComment): { id: ArtifactCommentId; present: boolean } => {
    let current = comment;
    for (let hops = 0; current.replyTo && hops < 50; hops += 1) {
      const parent = byId.get(current.replyTo);
      if (!parent) return parentsMayBeOlder ? { id: current.replyTo, present: false } : { id: current.id, present: true };
      current = parent;
    }
    return { id: current.id, present: true };
  };
  const threads = new Map<ArtifactCommentId, ArtifactCommentThread>();
  for (const comment of ordered) {
    const { id, present } = rootIdOf(comment);
    const thread = threads.get(id) ?? { id, root: null, replies: [], first: comment };
    if (present && id === comment.id) thread.root = comment;
    else thread.replies.push(comment);
    threads.set(id, thread);
  }
  for (const thread of threads.values()) thread.first = thread.root ?? thread.replies[0]!;
  return [...threads.values()].sort((a, b) => a.first.createdAt.localeCompare(b.first.createdAt));
}

/** What a group of threads is about: the whole Artifact, or one file. */
export type ArtifactCommentGroup =
  | { kind: "artifact"; threads: ArtifactCommentThread[] }
  | { kind: "file"; path: string; threads: ArtifactCommentThread[] };

/**
 * The list's groups: the whole Artifact first, then each file in the
 * version's order (files no longer in it after them). In a file, comments on
 * the whole file come before anchored ones; each part oldest first.
 */
export function groupThreads(threads: readonly ArtifactCommentThread[], files: readonly ArtifactFile[]): ArtifactCommentGroup[] {
  const whole = threads.filter((t) => t.first.target.scope === "artifact");
  const byPath = new Map<string, ArtifactCommentThread[]>();
  for (const thread of threads) {
    const target = thread.first.target;
    if (target.scope !== "file") continue;
    byPath.set(target.path, [...(byPath.get(target.path) ?? []), thread]);
  }
  const order = files.map((f) => f.path);
  const paths = [...byPath.keys()].sort((a, b) => rank(order, a) - rank(order, b));
  const groups: ArtifactCommentGroup[] = whole.length > 0 ? [{ kind: "artifact", threads: whole }] : [];
  for (const path of paths) {
    const list = byPath.get(path)!;
    const fileLevel = list.filter((t) => anchorOf(t.first) === null);
    groups.push({ kind: "file", path, threads: [...fileLevel, ...list.filter((t) => anchorOf(t.first) !== null)] });
  }
  return groups;
}

function rank(order: string[], path: string): number {
  const index = order.indexOf(path);
  return index < 0 ? order.length : index;
}

export function anchorOf(comment: ArtifactComment): ArtifactCommentAnchor | null {
  return comment.target.scope === "file" ? comment.target.anchor : null;
}

export function isOwnComment(comment: ArtifactComment, viewer: ArtifactViewerActor | null): boolean {
  return !!viewer && actorKey(comment.author) === actorKey(viewer);
}

// ---- Resolved threads (#249) ----

/** A thread is resolved by its root (a reply never is): the list folds it away, the page marks it no more. */
export const isResolvedThread = (thread: Pick<ArtifactCommentThread, "root">): boolean => !!thread.root?.resolvedAt;

/**
 * Whether the viewer may resolve or reopen the thread `root` starts, as the server decides
 * (resolutions.ts mayResolve): one who takes part in the Artifact (`comment`), and the thread's
 * author or one who may delete the Artifact (`delete`: its author, the person who manages an agent
 * author, the server's owners and admins; the same check). Not a thread whose root isn't loaded.
 */
export function mayResolveThread(
  root: ArtifactComment | null,
  viewer: ArtifactViewerActor | null,
  capabilities: Pick<ArtifactCapabilities, "comment" | "delete">,
): boolean {
  return !!root && capabilities.comment && (capabilities.delete || isOwnComment(root, viewer));
}

/**
 * The list after `reply` was posted: a reply in a resolved thread reopens it (the server does,
 * resolutions.ts reopenThreadsOf), so its root, found up the reply chain, is open here too.
 */
export function reopenedBy(list: readonly ArtifactComment[], reply: ArtifactComment): ArtifactComment[] {
  if (!reply.replyTo) return [...list];
  const byId = new Map(list.map((c) => [c.id, c]));
  let root = byId.get(reply.replyTo);
  for (let hops = 0; root?.replyTo && hops < 50; hops += 1) root = byId.get(root.replyTo);
  if (!root?.resolvedAt) return [...list];
  const open = root.id;
  return list.map((c) => (c.id === open ? { ...c, resolvedAt: null, resolvedBy: null } : c));
}

// ---- The comment box's text ----

/** How a mention reads in the box. */
export const mentionToken = (actor: ArtifactActor): string => `@${actor.displayName}`;

/** An actor's handle, as the @ picker shows it beside the name. */
export const mentionHandle = (actor: ArtifactActor): string => `@${actor.name}`;

/** Where a token ends: the end of the text, or a character that can't be part of a name. */
function endsWord(text: string, index: number): boolean {
  return index >= text.length || !/[\p{L}\p{N}_-]/u.test(text[index]!);
}

/**
 * The box's text as body parts: every `@Name` of an actor picked from the
 * list becomes a mention of that actor; the rest is text. A picked name that
 * was typed over or deleted is just text (no mention).
 */
export function bodyFromDraft(text: string, picked: readonly ArtifactActor[]): ArtifactWebCommentInput["body"] {
  // Longest names first, so "@Niko Bot" wins over "@Niko"; the last pick wins a tie.
  const actors = [...new Map(picked.map((a) => [mentionToken(a), a])).values()].sort((a, b) => mentionToken(b).length - mentionToken(a).length);
  const body: ArtifactWebCommentInput["body"] = [];
  let text_ = "";
  let i = 0;
  while (i < text.length) {
    const actor = text[i] === "@" ? actors.find((a) => text.startsWith(mentionToken(a), i) && endsWord(text, i + mentionToken(a).length)) : undefined;
    if (actor) {
      if (text_) body.push({ type: "text", text: text_ });
      text_ = "";
      body.push({ type: "mention", actor: { type: actor.type, id: actor.id } });
      i += mentionToken(actor).length;
    } else {
      text_ += text[i];
      i += 1;
    }
  }
  if (text_) body.push({ type: "text", text: text_ });
  return trimBody(body);
}

/** Leading and trailing white space of the whole body goes. */
function trimBody(body: ArtifactWebCommentInput["body"]): ArtifactWebCommentInput["body"] {
  const parts = [...body];
  const first = parts[0];
  if (first?.type === "text") parts[0] = { type: "text", text: first.text.trimStart() };
  const lastIndex = parts.length - 1;
  const last = parts[lastIndex];
  if (last?.type === "text") parts[lastIndex] = { type: "text", text: last.text.trimEnd() };
  return parts.filter((p) => p.type !== "text" || p.text.length > 0);
}

/** The actors a draft mentions, once each, in order. */
export function mentionedActors(text: string, picked: readonly ArtifactActor[]): ArtifactActor[] {
  const keys = new Set(bodyFromDraft(text, picked).flatMap((p) => (p.type === "mention" ? [actorKey(p.actor)] : [])));
  return [...new Map(picked.filter((a) => keys.has(actorKey(a))).map((a) => [actorKey(a), a])).values()];
}

/** A stored comment back as box text and its picked actors (to edit it). */
export function draftFromBody(body: readonly ArtifactCommentPart[]): { text: string; picked: ArtifactActor[] } {
  const picked: ArtifactActor[] = [];
  const text = body.map((part) => {
    if (part.type === "text") return part.text;
    picked.push(part.actor);
    return mentionToken(part.actor);
  }).join("");
  return { text, picked };
}

// ---- Will notify ----

/**
 * The line beside the box: the server's answer (I10) and the actors the
 * draft @mentions (reason `mentioned`; the server leaves the draft out), once
 * each, the server's reason first. The viewer never notifies themselves.
 */
export function mergeWillNotify(
  server: ArtifactWillNotify["recipients"] | null,
  mentioned: readonly ArtifactActor[],
  viewer: ArtifactViewerActor | null,
): ArtifactWillNotify["recipients"] {
  const seen = new Set<string>(viewer ? [actorKey(viewer)] : []);
  const out: ArtifactWillNotify["recipients"] = [];
  for (const recipient of [...(server ?? []), ...mentioned.map((actor) => ({ actor, reason: "mentioned" as const }))]) {
    const key = actorKey(recipient.actor);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(recipient);
  }
  return out;
}

// ---- Anchors in the shell (text and csv) ----

/** The anchors the shell draws itself (F37): lines of a text file, rows of a csv. */
export type ShellAnchor = Extract<ArtifactCommentAnchor, { type: "lines" | "csv-rows" }>;

export const isShellAnchor = (anchor: ArtifactCommentAnchor | null): anchor is ShellAnchor => anchor?.type === "lines" || anchor?.type === "csv-rows";

/** A comment's quote, cut short (anchors carry a short quote, never the document). */
export function shortQuote(text: string, max = 200): string | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Is a line or row anchor still where it points in the shown text? Its range
 * must be inside the file, and when it carries a quote the first line or
 * row of it must still read the same (written on another version, the
 * passage may have moved or gone: E9 shows its place dimmed, as lost).
 */
export function shellAnchorFound(anchor: ShellAnchor, units: readonly string[]): boolean {
  const { start, end, quote } = anchor.data;
  if (start < 1 || end < start || end > units.length) return false;
  if (!quote) return true;
  const firstQuoteLine = quote.split("\n")[0]!.replace(/\s+/g, " ").trim();
  const shown = units.slice(start - 1, end).join(" ").replace(/\s+/g, " ");
  return firstQuoteLine.length === 0 || shown.includes(firstQuoteLine.replace(/…$/, ""));
}
