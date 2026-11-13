import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Edit draws and focuses its box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import type { IntlShape } from "react-intl";
import { useIntl } from "react-intl";
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  Drawer,
  DrawerContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelAction,
  PanelActions,
  PanelFooter,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelTitle,
  Text,
  ScrollArea,
} from "@botiverse/raft-ui";
import { CommentCard, CommentCardMeta } from "@botiverse/raft-ui/wip";
import type { ArtifactActor, ArtifactComment, ArtifactCommentDraft, ArtifactCommentDraftId, ArtifactReviewRejected, ArtifactWillNotify } from "@botiverse/raft-shared";

import ConfirmDialog from "../../components/ConfirmDialog";
import Tooltip from "../../components/ui/Tooltip";
import { requestFocus } from "../../utils/focusRequest";
import { DraftPlace } from "./ArtifactActorParts";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { ArtifactCommentGallery } from "./ArtifactCommentGallery";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import type { ArtifactCommentBoxBatch } from "./ArtifactCommentBox";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import type { ArtifactReviewProblem } from "./ArtifactReviewContext";
import { actorKey, draftFromBody, mergeWillNotify, shortQuote } from "./artifactComments";
import { draftExcerpt, useDeleteDraft } from "./artifactDraftDelete";
import { draftDrawn } from "./artifactRestoredFocus";
import { artifactSource } from "./artifactSource";
import { draftDaysLeft, draftExpiresSoon } from "./artifactReviewDrafts";
import { artifactActorName } from "./artifactFacts";
import { formatNameList } from "./artifactNameList";
import { willNotifyText } from "./artifactWillNotify";

/**
 * Why the server refused this draft, as a person reads it: the code, with its typed details
 * (ArtifactReviewRejected). A mention refused names who, by the names the draft shows (never ids),
 * as the single-comment box says it.
 */
function draftReason(rejection: ArtifactReviewRejected, draft: ArtifactCommentDraft, intl: IntlShape): string {
  const { formatMessage } = intl;
  switch (rejection.code) {
    case "MENTION_NOT_VISIBLE": {
      const refused = new Set(rejection.details.actors.map(actorKey));
      const names = [...new Set(draft.body.flatMap((part) => (part.type === "mention" && refused.has(actorKey(part.actor)) ? [part.actor.displayName] : [])))];
      return names.length > 0
        ? formatMessage({ id: "artifacts.comments.errorMentionNotVisible" }, { names: formatNameList(intl, names), count: names.length })
        : formatMessage({ id: "artifacts.review.rejected.mentionNotVisible" });
    }
    case "FIELD_TOO_LONG":
      return rejection.details.field === "body"
        ? formatMessage({ id: "artifacts.review.rejected.tooLong" }, { limit: rejection.details.limit })
        : formatMessage({ id: "artifacts.review.rejected.invalid" });
    case "TOO_MANY_MENTIONS":
      return formatMessage({ id: "artifacts.review.rejected.tooManyMentions" }, { limit: rejection.details.limit });
    case "FILE_NOT_FOUND":
      return formatMessage({ id: "artifacts.review.rejected.fileNotFound" });
    case "VERSION_NOT_FOUND":
      return formatMessage({ id: "artifacts.review.rejected.versionNotFound" });
    case "COMMENT_NOT_FOUND":
      return formatMessage({ id: "artifacts.review.rejected.replyParentGone" });
    case "INVALID_PATH":
    case "INVALID_REQUEST":
      // What the draft keeps no longer passes as a comment (the rules tightened since it was saved).
      return formatMessage({ id: "artifacts.review.rejected.invalid" });
  }
}

/** C beside the content (desktop), in the comment list's place. */
export default function ArtifactReviewPanel() {
  return <ReviewContent />;
}

/** C on a phone: the same view as a bottom sheet (states.md). */
export function ArtifactReviewSheet() {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const close = useCallback((open: boolean) => { if (!open) review?.leaveReview(); }, [review]);
  return (
    <Drawer open onOpenChange={close}>
      <DrawerContent aria-label={formatMessage({ id: "artifacts.review.title" }, { count: review?.draftCount ?? 0 })} className="flex max-h-[82dvh] flex-col" data-testid="artifact-review-sheet">
        <ReviewContent sheet />
      </DrawerContent>
    </Drawer>
  );
}

/** A draft's text holds block Markdown (ArtifactCommentText): a div, never Text's p. */
const DRAFT_BODY_ELEMENT = <div />;

const REFUSED_IDS = {
  NOT_VISIBLE: "artifacts.review.refused.notVisible",
  VERSION_NOT_FOUND: "artifacts.review.refused.versionNotFound",
  FORBIDDEN: "artifacts.review.rejectedForbidden",
  other: "artifacts.review.refused.other",
} as const satisfies Record<Extract<ArtifactReviewProblem, { kind: "refused" }>["code"], string>;

/** What the banner over the drafts says for a submit that posted nothing. */
function problemText(problem: ArtifactReviewProblem, formatMessage: IntlShape["formatMessage"]): string {
  switch (problem.kind) {
    case "draftsChanged":
      return formatMessage({ id: "artifacts.review.draftsChanged" });
    case "rejected":
      // Every code a submit's 422 carries about a draft can be fixed here (edit or delete it); one about
      // none in particular (no summary is sent, so never the summary) is the review's as a whole.
      return formatMessage({ id: problem.rejection.draftId === null ? "artifacts.review.refused.other" : "artifacts.review.rejectedSummary" });
    case "refused":
      return formatMessage({ id: REFUSED_IDS[problem.code] });
  }
}

/**
 * C, where a refused send is fixed (#proj-workspace:#148: drafts are changed on the page, and Send N
 * sends them straight away; this opens only when a send posted nothing). Every draft, to edit or
 * delete, Discard All (confirmed) and Send N again, in the DS Panel's anatomy (header, body,
 * footer); no summary (none is sent). The banner says why nothing was sent; the refused draft is
 * marked with its reason (the code's typed details) and focused; editing it clears both. Drafts
 * changed meanwhile are loaded again and the review says so. While a submit is out nothing here
 * writes. From ARTIFACT_DRAFT_WARN_AFTER_DAYS a draft says when it goes. Never opened by a frame's
 * report, as Send and Delete are one click away here (THREAT_MODEL §6, co-design S6). Back goes to
 * the mode it was sent from.
 */
function ReviewContent({ sheet = false }: { sheet?: boolean }) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const headingId = useId();
  const regionRef = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<ArtifactCommentDraftId | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const focus = review?.reviewFocus;
  const problem = review?.problem ?? null;

  // The draft asked for (a bubble, a refusal): into view and focused. A send's answer opens this: not from a text field
  // or dialog the person went to while it was out (focus plan rule 2).
  useEffect(() => {
    if (!focus) return;
    const card = focus.draftId ? regionRef.current?.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(focus.draftId)}"]`) : null;
    card?.scrollIntoView?.({ block: "nearest" });
    requestFocus(() => card ?? regionRef.current, { reason: "async" });
  }, [focus]);
  const submitReview = review?.submit;
  const submit = useCallback(() => { void submitReview?.(); }, [submitReview]);
  const discard = useCallback(async () => {
    await review?.discardAll();
  }, [review]);
  const closeDiscard = useCallback(() => setConfirmDiscard(false), []);
  const askDiscard = useCallback(() => setConfirmDiscard(true), []);

  if (!review) return null;
  const moreLabel = formatMessage({ id: "artifacts.viewer.more" });
  const drafts = review.drafts ?? [];
  const count = drafts.length;
  const { submitting } = review;
  const rejected = problem?.kind === "rejected" ? problem.rejection : null;
  return (
    <section
      ref={regionRef}
      aria-labelledby={headingId}
      tabIndex={-1}
      aria-busy={submitting || undefined}
      className={`flex min-h-0 flex-col bg-layer-card outline-none ${sheet ? "flex-1" : "size-full"}`}
      data-testid="artifact-review-panel"
    >
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle id={headingId} render={<h2>{formatMessage({ id: "artifacts.review.title" }, { count })}</h2>} />
          </PanelHeading>
        </PanelHeaderContent>
        <PanelActions>
          {/* Discard All deletes every draft for good: behind ⋯ and a confirmation (co-design S6). */}
          <DropdownMenu>
            <Tooltip content={moreLabel}>
              <DropdownMenuTrigger
                render={(
                  <PanelAction aria-label={moreLabel} disabled={submitting} data-testid="artifact-review-more">
                    <EllipsisVertical />
                  </PanelAction>
                )}
              />
            </Tooltip>
            <DropdownMenuContent side="bottom" align="end" aria-label={moreLabel}>
              <DropdownMenuItem onClick={askDiscard} data-testid="artifact-review-discard">
                <Trash2 />
                {formatMessage({ id: "artifacts.review.discardAll" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PanelActions>
      </PanelHeader>
      {/* The drafts scroll in a raft-ui ScrollArea between the header and the
          footer, their column and padding on the content. Each draft card
          takes focus (edit, delete), so the list is no tab stop. */}
      <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col gap-2 px-3 py-3" data-testid="artifact-review-list">
        {review.draftsFailed ? (
          <Banner status="warning" size="sm" role="alert" data-testid="artifact-review-drafts-failed">
            <BannerDescription>{formatMessage({ id: "artifacts.review.draftsLoadFailed" })}</BannerDescription>
            <BannerAction>
              <Button variant="outline" size="md" onClick={review.reloadDrafts} data-testid="artifact-review-drafts-retry">
                {formatMessage({ id: "artifacts.review.retry" })}
              </Button>
            </BannerAction>
          </Banner>
        ) : null}
        {problem ? (
          <Banner
            status={problem.kind === "draftsChanged" ? "info" : "warning"}
            size="sm"
            role={problem.kind === "draftsChanged" ? "status" : undefined}
            data-testid={problem.kind === "draftsChanged" ? "artifact-review-drafts-changed" : "artifact-review-rejected-banner"}
            data-problem={problem.kind === "draftsChanged" ? undefined : problem.kind === "rejected" ? (problem.rejection.draftId === null ? "review" : "draft") : `refused:${problem.code}`}
          >
            <BannerDescription>{problemText(problem, formatMessage)}</BannerDescription>
          </Banner>
        ) : null}
        {drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            editing={editing === draft.id}
            onEdit={setEditing}
            rejection={rejected && rejected.draftId === draft.id ? rejected : null}
          />
        ))}
      </ScrollArea>
      <PanelFooter className="flex flex-col gap-2">
        <ReviewWillNotify drafts={review.drafts} />
        <div className="flex items-center justify-end gap-2">
          {/* Back with its word, not an icon: to the mode it was sent from. */}
          <Button variant="ghost" size="md" onClick={review.leaveReview} data-testid="artifact-review-back">
            {formatMessage({ id: "artifacts.review.back" })}
          </Button>
          <Button variant="primary" size="md" onClick={submit} disabled={submitting || count === 0} data-testid="artifact-review-submit">
            {formatMessage({ id: "artifacts.review.sendDrafts" }, { count })}
          </Button>
        </div>
      </PanelFooter>
      {confirmDiscard ? (
        <ConfirmDialog
          title={formatMessage({ id: "artifacts.review.discardTitle" }, { count })}
          message={formatMessage({ id: "artifacts.review.discardBody" })}
          confirmLabel={formatMessage({ id: "artifacts.review.discardConfirm" })}
          confirmTestId="artifact-review-discard-confirm"
          onConfirm={discard}
          onClose={closeDiscard}
        />
      ) : null}
    </section>
  );
}

/**
 * One draft: where it is (its quote or anchor, the file, or the whole Artifact; whom a reply
 * answers and the start of what it answers), its text, Edit (Save in place) and Delete (at once,
 * undoable from its toast and the bar; one with images after a confirmation: useDeleteDraft). C's card, and the comment list's "Your
 * drafts" (#148: drafts are changed where they are, by keyboard too). Its Edit and Delete are
 * named by the draft ("Edit draft: On the milestones…"), so a list of them can be told apart.
 * `onDelete`: the list's own (it moves focus after); else the draft is deleted here.
 */
export function DraftCard({ draft, editing, onEdit, rejection, onDelete }: {
  draft: ArtifactCommentDraft;
  editing: boolean;
  onEdit: (id: ArtifactCommentDraftId | null) => void;
  rejection: ArtifactReviewRejected | null;
  onDelete?: (draft: ArtifactCommentDraft) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const review = useArtifactReview()!;
  const comments = useArtifactComments();
  const reasonId = useId();
  const anchor = draft.target.scope === "file" ? draft.target.anchor : null;
  // A reply draft (B's Reply) is placed by its thread: whom it answers, from the comments loaded
  // (one on an earlier page, or deleted since, is said as the list says a reply to one it lacks).
  const replyTo = useMemo(() => (draft.replyTo ? comments?.comments?.find((c) => c.id === draft.replyTo && !c.deletedAt) ?? null : null), [draft.replyTo, comments?.comments]);
  const replyPlace = draft.replyTo ? replyPlaceText(replyTo, intl) : null;
  const place = replyPlace ?? (anchor
    ? <DraftPlace anchor={anchor} />
    : draft.target.scope === "file" ? draft.target.path : formatMessage({ id: "artifacts.comments.groupArtifact" }));
  const excerpt = draftExcerpt(draft, intl, replyPlace);
  const expiresSoon = draftExpiresSoon(draft);
  const { updateDraft, submitting } = review;
  const [deleteDraft, deleteDraftDialog] = useDeleteDraft();
  const batch = useMemo<ArtifactCommentBoxBatch>(() => ({
    label: formatMessage({ id: "artifacts.review.save" }),
    initial: draft.body,
    draftId: draft.id,
    onSubmit: (body) => updateDraft(draft.id, body),
    busy: submitting,
    images: draft.images,
  }), [formatMessage, draft.body, draft.id, updateDraft, submitting, draft.images]);
  const mode = useMemo(() => ({ kind: "new" as const, target: replyTo?.target ?? draft.target, replyTo }), [draft.target, replyTo]);
  const stopEditing = useCallback(() => onEdit(null), [onEdit]);
  // Drawn and focused within the press (flushSync), as Reply: iOS Safari opens the keyboard only for a focus made during
  // the tap itself, and an Edit is the person asking to type, on touch too.
  const startEditing = useCallback(() => flushSync(() => onEdit(draft.id)), [onEdit, draft.id]);
  // Made again by its deletion's toast (its Undo): focus comes as it is drawn (a ref, at once on mount).
  const draftId = draft.id;
  const editRef = useCallback((element: HTMLButtonElement | null) => {
    if (element) draftDrawn(draftId);
  }, [draftId]);
  const remove = useCallback(() => {
    if (onDelete) onDelete(draft);
    else void deleteDraft(draft);
  }, [onDelete, deleteDraft, draft]);
  const code = rejection?.code ?? null;
  const reason = rejection ? draftReason(rejection, draft, intl) : null;
  return (
    <>
      <CommentCard
        active={code !== null}
        tabIndex={-1}
        aria-invalid={code !== null || undefined}
        aria-describedby={code ? reasonId : undefined}
        className={`outline-none ${code ? "border-danger" : "border-dashed"}`}
        data-testid="artifact-review-draft"
        data-draft-id={draft.id}
        data-rejected={code ?? undefined}
      >
        <CommentCardMeta>
          <span className="min-w-0 flex-1 truncate" data-testid="artifact-review-draft-place" data-reply-to={draft.replyTo ?? undefined}>{place}</span>
        </CommentCardMeta>
        {editing ? (
          <ArtifactDismissableBox onDismiss={stopEditing}>
            <ArtifactCommentBox mode={mode} batch={batch} autoFocusKey={draft.id} onDone={stopEditing} onCancel={stopEditing} />
          </ArtifactDismissableBox>
        ) : (
          <>
            <Text.Sans size="body" render={DRAFT_BODY_ELEMENT} data-testid="artifact-review-draft-body">
              <ArtifactCommentText body={draft.body} viewer={comments?.viewer ?? null} />
            </Text.Sans>
            <ArtifactCommentGallery artifactId={comments?.data.card.id ?? null} images={draft.images} />
          </>
        )}
        {reason ? (
          <Text.Sans id={reasonId} role="alert" size="small" variant="danger" data-testid="artifact-review-draft-reason">{reason}</Text.Sans>
        ) : null}
        {expiresSoon ? (
          <Text.Sans size="small" variant="warning" data-testid="artifact-review-draft-expires">
            {formatMessage({ id: "artifacts.review.expires" }, { days: draftDaysLeft(draft) })}
          </Text.Sans>
        ) : null}
        {editing ? null : (
          <div className="flex gap-1">
            <Button ref={editRef} variant="ghost" size="md" onClick={startEditing} disabled={submitting} aria-label={formatMessage({ id: "artifacts.review.editDraftNamed" }, { excerpt })} data-testid="artifact-review-draft-edit">
              <Pencil />
              {formatMessage({ id: "artifacts.review.edit" })}
            </Button>
            <Button variant="ghost" size="md" onClick={remove} disabled={submitting} aria-label={formatMessage({ id: "artifacts.review.deleteDraftNamed" }, { excerpt })} data-testid="artifact-review-draft-delete">
              <Trash2 />
              {formatMessage({ id: "artifacts.review.delete" })}
            </Button>
          </div>
        )}
      </CommentCard>
      {deleteDraftDialog}
    </>
  );
}

/**
 * Where a reply draft is, in words: whom it answers and the start of what they said ("Replying to
 * Ana: “Can we move…”"), so it reads with its thread in "Your drafts" too; one whose comment isn't
 * among those loaded (an earlier page, or deleted since) as the list says a reply to one it lacks.
 */
function replyPlaceText(replyTo: ArtifactComment | null, intl: IntlShape): string {
  const { formatMessage } = intl;
  if (!replyTo) return formatMessage({ id: "artifacts.comments.replyToEarlier" });
  const name = artifactActorName(replyTo.author, formatMessage);
  const words = shortQuote(draftFromBody(replyTo.body).text, REPLY_PLACE_CHARS);
  return words
    ? formatMessage({ id: "artifacts.comments.replyingToThread" }, { name, thread: formatMessage({ id: "artifacts.review.quote" }, { quote: words }) })
    : formatMessage({ id: "artifacts.comments.replyingTo" }, { name });
}

/** How much of the comment a reply draft answers its place quotes. */
const REPLY_PLACE_CHARS = 40;

/**
 * Who the batch notifies, by name (co-design S6): the server's will-notify answer for each place
 * the drafts are on (each file, or the whole Artifact) and everyone the drafts @mention, once each.
 * Nothing more (xxchan, #proj-workspace:f555cdb3: one notification per batch goes without saying).
 */
function ReviewWillNotify({ drafts: loaded }: { drafts: readonly ArtifactCommentDraft[] | null }) {
  const comments = useArtifactComments();
  const id = comments?.data.card.id ?? null;
  const viewer = comments?.viewer ?? null;
  const lineId = useId();
  const drafts = useMemo(() => loaded ?? [], [loaded]);
  // Each place once: a file's path, or "" for the whole Artifact.
  const placesKey = [...new Set(drafts.map((d) => (d.target.scope === "file" ? d.target.path : "")))].sort().join("\n");
  const key = id ? `${id}|${placesKey}` : null;
  const [answer, setAnswer] = useState<{ key: string; recipients: ArtifactWillNotify["recipients"] } | null>(null);
  useEffect(() => {
    if (!id || !key) return;
    let cancelled = false;
    // Read again only when the places change (a draft edited keeps them).
    Promise.all(placesKey.split("\n").map((path) => artifactSource().willNotify(id, path ? { path } : {}))).then(
      (answers) => { if (!cancelled) setAnswer({ key, recipients: answers.flatMap((a) => a.recipients) }); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [id, key, placesKey]);
  const server = answer?.key === key ? answer.recipients : null;
  const mentioned = useMemo(
    () => drafts.flatMap((d) => d.body.flatMap((part): ArtifactActor[] => (part.type === "mention" ? [part.actor] : []))),
    [drafts],
  );
  const recipients = useMemo(() => mergeWillNotify(server, mentioned, viewer), [server, mentioned, viewer]);
  return (
    <div className="flex flex-col gap-0.5" data-testid="artifact-review-will-notify">
      <WillNotifyLine id={lineId} recipients={recipients} loaded={server !== null} />
    </div>
  );
}

/** Who the pending review notifies: a line under its drafts (the batch as a whole). */
function WillNotifyLine({ id, recipients, loaded }: { id: string; recipients: ArtifactWillNotify["recipients"]; loaded: boolean }) {
  const intl = useIntl();
  if (!loaded) return <p id={id} className="sr-only" />;
  return (
    <div id={id} className="flex flex-col gap-0.5 text-footnote text-foreground-muted" data-testid="artifact-will-notify">
      <p>{willNotifyText(recipients, intl)}</p>
    </div>
  );
}
