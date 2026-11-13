import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { ArtifactId } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
import { commentAnchorOf, eventServer, trackArtifactCommentPosted } from "./artifactAnalytics";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import { artifactSource } from "./artifactSource";

/**
 * "This page hit an error" (#proj-workspace:#131; xxchan asked, Tenny set the bounds): the framed
 * page the reader is viewing reported an error (Porthole's `onContentError`: what it threw, an
 * unhandled rejection, what the sandbox blocked; the shell sends at most `maxErrorReports` a run,
 * only where the display declares `reportError`, which Raft's `errors: "host"` keeps), and the
 * viewer offers "Let the agent fix it".
 *
 * - Never sent by itself: the error's text may carry what the reader sees, so only the reader's
 *   click posts it, as one comment of theirs on the whole Artifact (the usual comment route; the
 *   server notifies the author's agent as for any comment).
 * - Only where the reader may comment (`capabilities.comment`), and only in comment mode's A
 *   (browsing, or no comment mode): never on the public page (no comments context there).
 * - Once per version and message: sent or dismissed, the same message on the same version doesn't
 *   ask again, for this mount and for the tab's session (sessionStorage).
 * - The text is the page's word: drawn as text only (`<bdi dir="auto">`), sent as a text part.
 */

/** How much of the first message goes into the comment. */
export const PAGE_ERROR_MESSAGE_MAX = 500;
/** How many distinct messages one mount keeps (Porthole sends at most a few a run anyway). */
const MAX_MESSAGES = 20;
const STORAGE_PREFIX = "raft.artifactPageError.";
const NONE: readonly string[] = [];

/** A short, stable hash of a message (FNV-1a, 32 bits, base 36): a storage key, never shown. */
export function pageErrorHash(message: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < message.length; i += 1) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Where a message on a version is remembered as answered (sent or dismissed). */
export function pageErrorKey(id: ArtifactId, version: number, message: string): string {
  return `${STORAGE_PREFIX}${id}@${version}.${pageErrorHash(message)}`;
}

function answeredInSession(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function rememberInSession(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // No storage (a private window, a full quota): this mount still remembers it.
  }
}

/** At most `max` characters (never half a surrogate pair), with an ellipsis where it was cut. */
export function clipPageError(message: string, max = PAGE_ERROR_MESSAGE_MAX): string {
  const chars = Array.from(message);
  return chars.length <= max ? message : `${chars.slice(0, max).join("")}…`;
}

/** The comment's text: the version, the viewer's width, the first message (clipped), how many more. */
export function pageErrorCommentText(formatMessage: IntlShape["formatMessage"], input: { version: number; width: number; messages: readonly string[] }): string {
  const body = formatMessage(
    { id: "artifacts.pageError.commentBody" },
    { version: String(input.version), width: String(input.width), message: clipPageError(input.messages[0] ?? "") },
  );
  const more = input.messages.length - 1;
  return more > 0 ? `${body}\n${formatMessage({ id: "artifacts.pageError.commentMore" }, { count: more })}` : body;
}

export interface ArtifactPageErrors {
  /** For the frame's `onContentError`. */
  onContentError: (message: string) => void;
  /** The messages not yet answered, in the order they came, when the notice may ask; else empty. */
  shown: readonly string[];
  sending: boolean;
  send: () => void;
  dismiss: () => void;
}

/**
 * The page's error reports for one frame mount (ArtifactFrame is keyed by version). `frameWidth`:
 * the frame's width in px when asked (null or 0: the window's).
 */
export function useArtifactPageErrors(id: ArtifactId, version: number, frameWidth: () => number | null): ArtifactPageErrors {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const review = useArtifactReview();
  const [messages, setMessages] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const answered = useRef(new Set<string>());
  const sendingRef = useRef(false);

  const isAnswered = useCallback((message: string) => {
    const key = pageErrorKey(id, version, message);
    return answered.current.has(key) || answeredInSession(key);
  }, [id, version]);

  const answer = useCallback((list: readonly string[]) => {
    for (const message of list) {
      const key = pageErrorKey(id, version, message);
      answered.current.add(key);
      rememberInSession(key);
    }
    setMessages((current) => current.filter((message) => !list.includes(message)));
  }, [id, version]);

  const onContentError = useCallback((raw: string) => {
    const message = raw.trim();
    if (message === "" || isAnswered(message)) return;
    setMessages((current) => (current.includes(message) || current.length >= MAX_MESSAGES ? current : [...current, message]));
  }, [isAnswered]);

  const mayAsk = comments !== null
    && comments.data.card.id === id
    && comments.data.capabilities.comment
    && (review === null || review.status === "browsing");
  const shown = mayAsk ? messages : NONE;

  const send = useCallback(() => {
    if (!comments || sendingRef.current || shown.length === 0) return;
    const sent = [...shown];
    const measured = frameWidth();
    const width = Math.round(measured && measured > 0 ? measured : window.innerWidth);
    const text = pageErrorCommentText(formatMessage, { version, width, messages: sent });
    const target = { scope: "artifact" } as const;
    sendingRef.current = true;
    setSending(true);
    const at = eventServer();
    void artifactSource().postComment(id, { body: [{ type: "text", text }], version, target, replyTo: null }).then((created) => {
      trackArtifactCommentPosted({ anchor: commentAnchorOf(target), isReply: false, mentions: 0 }, at);
      comments.added(created.comment);
      answer(sent);
    }, () => {
      showToast({ title: formatMessage({ id: "artifacts.comments.errorFailed" }), type: "error" });
    }).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  }, [comments, shown, frameWidth, formatMessage, version, id, answer]);

  const dismiss = useCallback(() => answer(shown), [answer, shown]);

  return { onContentError, shown, sending, send, dismiss };
}
