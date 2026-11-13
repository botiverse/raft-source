import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, FormEvent, KeyboardEvent, ReactElement, RefObject, SyntheticEvent } from "react";
import { useIntl } from "react-intl";
import { matchesShortcut } from "../../features/shortcuts";
import { ArrowUp, X } from "lucide-react";
import {
  Badge,
  Button,
  Composer,
  ComposerActions,
  ComposerInput,
  ComposerMeta,
  ComposerRoot,
  ComposerSubmit,
  ComposerToolbar,
} from "@botiverse/raft-ui";
import { focusField } from "@botiverse/porthole";
import { ARTIFACT_COMMENT_MAX_MENTIONS, ARTIFACT_DRAFT_MAX_PER_ARTIFACT } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactCommentImage, ArtifactCommentPart, ArtifactWebCommentInput } from "@botiverse/raft-shared";

import { asFirstPartyAppId, asFirstPartyObjectId, asFirstPartyObjectKind, MentionSuggestionList, useMentionPicker } from "../../components/mention";
import type { MentionCandidate, MentionSource, MentionSuggestionGroup } from "../../components/mention";
import { useToastViewportFloor } from "../../components/toastViewportBottom";
import Tooltip from "../../components/ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { ArtifactCardHoldContext } from "./artifactCardHold";
import { commentAnchorOf, eventServer, trackArtifactCommentPosted } from "./artifactAnalytics";
import { artifactErrorCode, artifactErrorDetails } from "./artifactApi";
import { isInputMethodKey } from "./artifactInputMethodKey";
import {
  actorKey,
  bodyFromDraft,
  draftFromBody,
  mentionedActors,
  mentionToken,
  mergeWillNotify,
} from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { watchFocusIntent } from "../../utils/focusRequest";
import { TOUCH_QUERY } from "./ArtifactReviewContext";
import type { SentFrom } from "./ArtifactCommentsContext";
import { CommentImageChips, KeptCommentImages } from "./ArtifactCommentImageChips";
import { CommentImageAttachButton, CommentImageDropOverlay, CommentImageRefusedBanner, CommentImageUnresolvedNote } from "./ArtifactCommentImages";
import { artifactSource } from "./artifactSource";
import { useServerWillNotify, willNotifyText } from "./artifactWillNotify";
import { formatNameList } from "./artifactNameList";
import { SheetNotifyContext } from "./artifactSheetNotify";
import { imagesInput } from "./useCommentImageAttachments";
import { useCommentBoxImages } from "./useCommentBoxImages";
import type { CommentBoxImageListeners } from "./useCommentBoxImages";
import { useCommentBoxArming } from "./useCommentBoxArming";
import { flushArtifactLocalDrafts } from "./artifactLocalDrafts";
import { useCommentBoxLocalDraft, useKeptWords } from "./useCommentBoxLocalDraft";
import { artifactActorName } from "./artifactFacts";

const PHONE_QUERY = "(max-width: 767px)";
const NO_IMAGES: readonly ArtifactCommentImage[] = [];

export type { ArtifactCommentBoxBatch, ArtifactCommentBoxDraftOption, ArtifactCommentBoxKeep, ArtifactCommentBoxMode } from "./artifactCommentBoxShapes";
import { actorOf, mentionOptionTestId } from "./artifactCommentBoxShapes";
import type { ArtifactCommentBoxBatch, ArtifactCommentBoxDraftOption, ArtifactCommentBoxKeep, ArtifactCommentBoxMode, BoxAction, BoxError } from "./artifactCommentBoxShapes";

/**
 * The comment box (raft-ui Composer): plain text, `@` opens raft-ui's suggestion list (a listbox
 * driven from the textarea with aria-activedescendant; arrows move, Enter or Tab picks, Esc closes
 * it before anything else). A picked name stays plain `@Name` text in the box and becomes a mention
 * part when sent; typing over it makes it text again.
 *
 * Who will hear about the comment (I10): the server's will-notify answer and the people and agents
 * the draft @mentions, once each, is the send button's tooltip, and the field's description for
 * assistive tech; nothing is drawn under the box (#proj-workspace:#148).
 *
 * A new comment at a place in the page, or a reply in comment mode (`draftOption`), has two
 * actions: Send and Save Draft (ArtifactCommentBoxDraftOption).
 *
 * At most ARTIFACT_COMMENT_MAX_MENTIONS distinct people and agents per comment (the author
 * included): once the draft has that many, the picker offers only those already mentioned. Send
 * stays on; a mention typed back by hand past the cap gets the server's 400 TOO_MANY_MENTIONS, said
 * inline with the draft kept.
 *
 * In a card held for a press (artifactCardHold, Porthole P134), nothing here writes (`send`, which
 * says so instead), and Tab doesn't stop in the field. Keys alone can't send, a real click comes first.
 *
 * Opened by the page's button (`pageOpen`, Porthole comments.open, P108): the box starts with the
 * page's draft as its plain text (an `@Name` in it is text, never a mention, unless the person picks
 * the name), says it is the page's, and is armed as Porthole's THREAT_MODEL §6 arms a view the content
 * brought: for 500 ms no Enter sends and Send takes no press, and a press or key that began before
 * that never sends after it. It takes no focus (Tenny, #11389; THREAT_MODEL §6): focus stays where
 * the person had it, in the page too, so what they type next (into the page's own field, whose keys
 * are the activation that let the page ask) never lands in the box, and no Enter meant for the page
 * sends it. The person clicks or tabs into the box themselves; it is posted only on their own Enter
 * or Send there. Porthole 0.13 (ADOPTING "A page's draft"): the box says "Suggested by this page"
 * until the person edits the text, and, stricter than 0.13 (which lets Send be a click), Send stays
 * off until the person has clicked or tabbed into the box or edited it, so nothing the page wrote is
 * ever one click from posted.
 *
 * Words Raft puts in it (`insert`: Doesn't display well here's, #243) go after the person's own, an
 * empty line between, as if typed there: the box takes focus with the caret at the end.
 *
 * Opened focused (a selection, Reply), focus moves in with Porthole's `focusField`, never the
 * field's own `focus()`: on Firefox a frame that holds focus with the person's gesture keeps a plain
 * `focus()` from landing.
 *
 * The person's words are kept on this device as they write (artifactLocalDrafts,
 * #proj-workspace:#144): under the signed-in person, the server, the Artifact and
 * the box's place (a new comment's target, the comment replied to or edited, the
 * comment mode draft edited), written ARTIFACT_LOCAL_DRAFT_SAVE_MS after the last
 * change and at once when the box loses focus, goes, or the page is hidden. A box
 * that opens empty (an edit: as the comment reads) starts with them again (the
 * words in the box say so; #250: no note). Sent, emptied, or cancelled (×, Cancel),
 * they are dropped. A page's untouched suggestion is never kept, and a box the page
 * opened never starts with kept words.
 *
 * While it holds words the person typed (`typed`: not an edit as the comment reads) it is marked
 * `data-artifact-typed`, all the dismissal layer reads of it (artifactDismissLayer): a press outside
 * closes only what holds none. Esc in a reply or an edit opened in place follows that rule: nothing
 * typed, it leaves the box; typed words stay in the box, in view (Kirby: never put away to come back
 * at the next Edit, where Save would apply them unseen). Cancel or × is how they are dropped.
 */
export default function ArtifactCommentBox({
  mode,
  onDone,
  onCancel,
  autoFocusKey,
  pageOpen = null,
  batch = null,
  draftOption = null,
  guardsPagePlace = true,
  onOwnText,
  revealSent = null,
  standing = false,
  inCard = false,
  adoptKey = null,
  insert = null,
  keepRef,
  discardRef,
}: {
  mode: ArtifactCommentBoxMode;
  /**
   * Done (sent, saved). An edit's saved after the server answered: `wanted`, watched from the save (watchFocusIntent),
   * says whether a focus move is still wanted then (focus plan rule 3); ask it, so it stops watching.
   */
  onDone?: (wanted?: () => boolean) => void;
  /**
   * Leave the box (its words dropped): a reply by the × of its "Replying to" line; an edit or a
   * draft edited by Cancel at the start of its toolbar (Kirby). A reply's, an edit's and a draft's
   * by Esc too, while it holds no typed words. A new comment's card passes none: its own × is its
   * Cancel (ArtifactComposeCard).
   */
  onCancel?: () => void;
  /** Focus the box whenever this changes (a comment started from the page). */
  autoFocusKey?: string | number | null;
  /** The page's button opened this box (P108): with the text it starts with (null: empty). Read on mount. */
  pageOpen?: { draft: string | null; key: number } | null;
  /** A draft being edited: the box saves it (ArtifactCommentBoxBatch). */
  batch?: ArtifactCommentBoxBatch | null;
  /** A new comment or reply that may also be kept as a draft: Send and Save Draft (ArtifactCommentBoxDraftOption). */
  draftOption?: ArtifactCommentBoxDraftOption | null;
  /**
   * Whether the person's words here keep a page's button from opening its box (true): false for
   * the box at the comment list's foot, a place of its own the page's box never takes.
   */
  guardsPagePlace?: boolean;
  /** Whether the box holds the person's own words, as they change (comment mode's A Comment box). */
  onOwnText?: (own: boolean) => void;
  /**
   * Once posted, the new comment shows where it landed, marked Sent (ArtifactCommentsContext
   * `revealSent`), for a box that closes or clears when it sends, where it would otherwise seem
   * to vanish. A card at a place (`SentFrom`: a selection's Comment; a new comment's card, which
   * leaves closing itself to `revealSent`, no `onDone`) becomes the comment's thread card there
   * when the place gets a marker; `"list"` (the list's foot, under the list) marks it in the list.
   * Shown from what is open when the answer comes (ArtifactCommentsContext reads it then), not
   * what was open when this box last rendered: a marker pressed meanwhile keeps its card.
   * Not a reply in a thread's card or the list: it shows there already.
   */
  revealSent?: "list" | SentFrom | null;
  /** The list's foot box, always there: only focus or words make it count as the person writing (`boxEngaged`). */
  standing?: boolean;
  /**
   * A new comment's box whose card keeps its words as a draft when it closes with them
   * (SelectionBox, #proj-workspace:#229): set to what does it, through Save Draft's own path
   * (`draftOption`, the same checks, the box's `onDone` once saved).
   */
  keepRef?: RefObject<(() => Promise<ArtifactCommentBoxKeep>) | null>;
  /** A new comment's card, whose × is this box's Cancel (ArtifactComposeCard): set to what drops its words. */
  discardRef?: RefObject<(() => void) | null>;
  /** In the open thread's card: while it holds words or focus, the card stays when its passage is gone. */
  inCard?: boolean;
  /**
   * The list's foot: another box's kept words it takes (an unsent comment whose place can't be
   * shown after a reload, useUnsentCommentOffer), by their key, after its own. Read on mount; once
   * kept here, gone from there.
   */
  adoptKey?: string | null;
  /** Words to put in the box once per `key`, after any it holds (a new comment's box). */
  insert?: { key: number; text: string } | null;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const comments = useArtifactComments();
  const hold = useContext(ArtifactCardHoldContext);
  const phone = useMediaQuery(PHONE_QUERY);
  const coarse = useMediaQuery(TOUCH_QUERY);
  const pageDraft = mode.kind === "new" ? pageOpen?.draft ?? null : null;
  const fromPage = mode.kind === "new" && pageOpen !== null;
  // A box the page opened: whether the person has acted in it (clicked or tabbed in, edited) and
  // whether they have edited its text. Until they act, Send is off; until they edit, the text is
  // the page's suggestion.
  const [theirs, setTheirs] = useState(!fromPage);
  const [edited, setEdited] = useState(false);
  // A page's draft is the box's text, picked by no one: nothing in it is a mention.
  const batchInitial = batch?.initial;
  const initial = useMemo(() => (mode.kind === "edit"
    ? draftFromBody(mode.comment.body)
    : batchInitial ? draftFromBody(batchInitial) : { text: pageDraft ?? "", picked: [] as ArtifactActor[] }), [mode, pageDraft, batchInitial]);
  // Where its unsent words are kept on this device (artifactLocalDrafts), and those it starts with.
  const { localScope, localPlace, restored, adopted } = useCommentBoxLocalDraft({ artifactId: comments?.data.card.id ?? null, mode, batchDraftId: batch?.draftId, fromPage, adoptKey });
  // Images (#proj-workspace:#146): attached to a new comment or a reply (pasted, dropped, Add Image),
  // uploaded at once; an edit (of a comment or a draft) keeps the images it has, as they are.
  const attachable = mode.kind === "new" && !batch;
  const keptImages = (mode.kind === "edit" ? mode.comment.images : batch?.images) ?? NO_IMAGES;
  const imageListeners = useRef<CommentBoxImageListeners>({ changed: () => {}, counted: () => {} });
  const { images, count: imageCount, pasted, drop } = useCommentBoxImages(comments?.data.card.id ?? null, attachable, restored?.images ?? null, imageListeners);
  const [text, setText] = useState(restored?.text ?? initial.text);
  const [picked, setPicked] = useState<ArtifactActor[]>(restored?.picked ?? initial.picked);
  // It started with kept words the person hasn't touched yet (edited, picked into, sent or cleared): back
  // at them, they are the person's own (`tellOwnText` on focus). Nothing says so on screen (#250).
  const [keptUntouched, setKeptUntouched] = useState(restored !== null);
  const [focusedNow, setFocusedNow] = useState(false);
  const [rawError, setError] = useState<BoxError | null>(null);
  const [sending, setSending] = useState(false);
  // A page's draft never opens the @ picker by itself (its `@Name` under the caret, where an Enter
  // meant to send would pick that name): the picker waits for the person to type.
  const [pickerOn, setPickerOn] = useState(pageDraft === null);
  const serverRecipients = useServerWillNotify(mode.kind === "new" ? { replyTo: mode.replyTo?.id, path: mode.target.scope === "file" ? mode.target.path : undefined } : null);
  const errorId = useId();
  const notifyId = useId();
  const pageNoteId = useId();

  const mentioned = useMemo(() => mentionedActors(text, picked), [text, picked]);
  const atMentionCap = mentioned.length >= ARTIFACT_COMMENT_MAX_MENTIONS;
  // The shared @ picker over who can see this Artifact (the server decides; the box names the
  // audience). At the cap, only those already mentioned are offered (naming them again adds no one).
  const artifactId = comments?.data.card.id ?? null;
  const source = useMemo<MentionSource>(
    () => (artifactId
      // This app's object audience, as its registration names the app and the kind. Branded here, not at
      // module load: the mention module and this app import each other.
      ? { audience: { kind: "object", app: asFirstPartyAppId("artifacts"), objectKind: asFirstPartyObjectKind("artifact"), objectId: asFirstPartyObjectId(artifactId) } }
      : { local: [] }),
    [artifactId],
  );
  const groupCandidates = useCallback((ranked: MentionCandidate[]): MentionSuggestionGroup[] => {
    const already = atMentionCap ? new Set(mentioned.map(actorKey)) : null;
    const offered = already ? ranked.filter((c) => already.has(actorKey(c))) : ranked;
    const people = formatMessage({ id: "artifacts.comments.mentionPeople" });
    const agents = formatMessage({ id: "artifacts.comments.mentionAgents" });
    return [
      { key: "people", label: people, ariaLabel: people, items: offered.filter((c) => c.type === "user").map((candidate) => ({ candidate })) },
      { key: "agents", label: agents, ariaLabel: agents, items: offered.filter((c) => c.type === "agent").map((candidate) => ({ candidate })) },
    ];
  }, [atMentionCap, mentioned, formatMessage]);
  const picker = useMentionPicker({ source, group: groupCandidates, listboxLabel: formatMessage({ id: "artifacts.comments.mentionListLabel" }) });
  const { detect, dismiss, buildInsert, handleKeyDown: pickerKeyDown } = picker;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // The caret put there without focusing the box: words handed in on touch (`insert`, focus plan rule 5).
  const caretOnly = useRef(false);
  // That caret, while the box isn't focused: placed as it is (`focused`), not before. WebKit may focus a text field
  // whose selection is set and open the keyboard over the sheet.
  const caretOnFocus = useRef<number | null>(null);

  const invalidKeys = rawError?.kind === "mentionNotVisible" ? rawError.actors.map(actorKey).join(",") : "";
  const invalid = useMemo(() => (invalidKeys ? new Set(invalidKeys.split(",")) : null), [invalidKeys]);
  // A mention the server refused (can't see the Artifact) reaches no one.
  const recipients = useMemo(
    () => mergeWillNotify(serverRecipients, invalid ? mentioned.filter((a) => !invalid.has(actorKey(a))) : mentioned, comments?.viewer ?? null),
    [serverRecipients, mentioned, invalid, comments?.viewer],
  );
  const invalidMentioned = invalid ? mentioned.filter((a) => invalid.has(actorKey(a))) : [];
  // The refusal holds while one of the refused is still mentioned; removing them clears it.
  const error = rawError?.kind === "mentionNotVisible" && invalidMentioned.length === 0 ? null : rawError;
  // Editing: only mentions added in this edit notify (as with message edits); those already there aren't told again.
  const editRecipients = useMemo(() => {
    if (mode.kind !== "edit") return [];
    const before = new Set(initial.picked.map(actorKey));
    const added = mentioned.filter((a) => !before.has(actorKey(a)) && !invalid?.has(actorKey(a)));
    return mergeWillNotify([], added, comments?.viewer ?? null);
  }, [mode.kind, initial.picked, mentioned, invalid, comments?.viewer]);
  const body = useMemo(() => bodyFromDraft(text, picked), [text, picked]);
  // Text, or at least one image (the Server's rule); never while an image uploads or one failed or expired is in the box.
  const empty = body.length === 0 && images.ready.length === 0 && keptImages.length === 0;
  const waiting = images.uploading || images.unresolved;

  // Whether the new-comment box holds the person's own words (a page may not replace or move
  // them), told as they change: typed, sent, or gone with the box.
  const reportOwnText = mode.kind === "new" && guardsPagePlace ? comments?.setComposerHasOwnText : undefined;

  // The person's own content: their words, or an image they attached (a page may not move or close it).
  const tellOwnText = useCallback((value: string) => {
    const own = (value.trim() !== "" && value !== pageDraft) || imageCount.current > 0;
    reportOwnText?.(own);
    onOwnText?.(own);
  }, [reportOwnText, pageDraft, onOwnText, imageCount]);
  useEffect(() => () => reportOwnText?.(false), [reportOwnText]);
  // Every box, whatever its mode, tells the comments whether it holds the person's words now (an
  // edit's text from the start), has focus, or was opened by them: a newer version then waits
  // behind its strip (useFollowLatest), and a thread's card with words stays (CommentBoxState).
  const boxId = useId();
  const ownWords = (text.trim() !== "" && text !== pageDraft) || images.items.length > 0;
  const typed = (text.trim() !== "" && text !== initial.text && text !== pageDraft) || images.items.length > 0;
  const reportBox = comments?.reportBox;
  useEffect(() => {
    reportBox?.(boxId, { words: ownWords, focused: focusedNow, standing, inCard });
  }, [reportBox, boxId, ownWords, focusedNow, standing, inCard]);
  useEffect(() => () => reportBox?.(boxId, null), [reportBox, boxId]);

  // The words kept as the person changes them, and dropped with the box's Cancel (useKeptWords).
  const { keepWords, discardLocal } = useKeptWords({ localScope, localPlace, adopted, ready: images.ready, initialText: initial.text, pageDraft });
  imageListeners.current = { changed: (ready) => keepWords(text, picked, ready), counted: () => tellOwnText(text) };
  // The reply line's ×, an edit's Cancel: the words go with the box. A new comment's card's × too (`discardRef`).
  const cancel = useCallback(() => {
    discardLocal();
    onCancel?.();
  }, [discardLocal, onCancel]);
  useEffect(() => {
    if (!discardRef) return;
    discardRef.current = discardLocal;
    return () => { discardRef.current = null; };
  }, [discardRef, discardLocal]);

  // The picker opens and follows the name typed before the caret. A select event with the text
  // and caret as they were (after Esc closed it, say) leaves it as it is.
  const synced = useRef<{ value: string; caret: number } | null>(null);
  const syncQuery = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    const caret = input.selectionStart ?? input.value.length;
    if (event.type === "select" && synced.current?.value === input.value && synced.current.caret === caret) return;
    synced.current = { value: input.value, caret };
    detect(input.value.slice(0, caret), caret);
  }, [detect]);
  const changed = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
    setText(event.currentTarget.value);
    setTheirs(true);
    setEdited(true);
    setKeptUntouched(false);
    setPickerOn(true);
    tellOwnText(event.currentTarget.value);
    keepWords(event.currentTarget.value, picked);
    syncQuery(event);
    setError((current) => (current?.kind === "mentionNotVisible" ? current : null));
  }, [syncQuery, tellOwnText, keepWords, picked]);
  // Leaving the box closes the picker; coming back to the same caret opens it again. Its words are
  // written at once (a phone's keyboard closing may be the last thing before the page goes).
  const blurred = useCallback(() => {
    synced.current = null;
    setFocusedNow(false);
    flushArtifactLocalDrafts();
    dismiss();
  }, [dismiss]);
  const selected = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
    // Not while a pick is committing: the textarea still holds the text from before it.
    if (pickerOn && pendingCaret.current === null) syncQuery(event);
  }, [pickerOn, syncQuery]);
  // A page's draft: the caret after it when the box is first focused, to go on writing it.
  const caretPlaced = useRef(pageDraft === null);
  const focused = useCallback((event: FocusEvent<HTMLTextAreaElement>) => {
    // Only the person moves focus into a box the page opened (it opens without focus, and a page
    // can't move focus into Raft's fields): their click or Tab.
    setTheirs(true);
    setFocusedNow(true);
    // Kept words it started with are the person's own once they are back at them (a page may not
    // replace them then; until then they are kept on the device whatever opens).
    if (keptUntouched) tellOwnText(event.currentTarget.value);
    const handed = caretOnFocus.current;
    if (handed !== null) {
      caretOnFocus.current = null;
      caretPlaced.current = true;
      const at = Math.min(handed, event.currentTarget.value.length);
      event.currentTarget.setSelectionRange(at, at);
      return;
    }
    if (caretPlaced.current) return;
    caretPlaced.current = true;
    const end = event.currentTarget.value.length;
    event.currentTarget.setSelectionRange(end, end);
  }, [keptUntouched, tellOwnText]);

  // After a pick commits, the caret goes after the inserted name (the textarea holds the new text only then).
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    // Words changed otherwise (the page's, a restore): a caret kept for the focus no longer stands.
    if (caret === null) {
      caretOnFocus.current = null;
      return;
    }
    pendingCaret.current = null;
    const input = inputRef.current;
    if (!input) return;
    const only = caretOnly.current;
    caretOnly.current = false;
    if (!only) input.focus({ preventScroll: true });
    else if (input.ownerDocument.activeElement !== input) {
      caretOnFocus.current = caret;
      return;
    }
    caretOnFocus.current = null;
    input.setSelectionRange(caret, caret);
  }, [text]);
  // A pick puts `@Name ` in place of the typed `@na`, remembered so it becomes a mention.
  const pick = useCallback((candidate: MentionCandidate) => {
    const actor = actorOf(candidate);
    const caret = inputRef.current?.selectionStart ?? text.length;
    const { newContent, newCursor } = buildInsert(actor.displayName, text, caret);
    const nextPicked = [...picked.filter((a) => actorKey(a) !== actorKey(actor)), actor];
    setPicked(nextPicked);
    pendingCaret.current = newCursor;
    setText(newContent);
    setKeptUntouched(false);
    tellOwnText(newContent);
    keepWords(newContent, nextPicked);
    dismiss();
  }, [buildInsert, dismiss, text, picked, tellOwnText, keepWords]);
  // `insert`: focus with the caret at the end comes from the layout effect above, as for a pick; on touch the caret
  // alone, the person tapping in to write (no keyboard over the sheet the words opened, focus plan rule 5).
  const putIn = useCallback((words: string) => {
    const next = text.trim() === "" ? words : `${text.trimEnd()}\n\n${words}`;
    pendingCaret.current = next.length;
    caretOnly.current = coarse;
    setText(next);
    setKeptUntouched(false);
    tellOwnText(next);
    keepWords(next, picked);
    dismiss();
  }, [text, picked, tellOwnText, keepWords, dismiss, coarse]);
  // Once per key, in this box.
  const inserted = useRef<number | null>(null);
  useEffect(() => {
    if (!insert || mode.kind !== "new" || inserted.current === insert.key) return;
    inserted.current = insert.key;
    // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-pass-live-state-to-parent -- once per key (the guard above): words handed in, then the person's, as if typed; not state kept in sync
    putIn(insert.text);
  }, [insert, mode.kind, putIn]);
  // A box the page opened is never focused for the person (above).
  const focusOnOpen = pageOpen === null || mode.kind !== "new";
  useEffect(() => {
    const input = inputRef.current;
    if (autoFocusKey === undefined || autoFocusKey === null || !focusOnOpen || !input) return;
    // Porthole's move, not input.focus(): the frame may hold focus (the selection that opened this). The caret at the
    // end of the words it opens with (an edit's comment, a draft's, kept words), to write on from there.
    focusField(input);
    const end = input.value.length;
    input.setSelectionRange(end, end);
    input.scrollIntoView?.({ block: "nearest" });
  }, [autoFocusKey, inputRef, focusOnOpen]);

  // Armed once the page opened it (P108): nothing sends until then (useCommentBoxArming).
  const { arming, notePress, noteKey, armedOut } = useCommentBoxArming(fromPage);
  const mayPost = useCallback(() => theirs && armedOut(), [theirs, armedOut]);

  // A new comment or a reply may offer both (an edit is saved, as its box always was).
  const keeps = mode.kind === "new" ? draftOption : null;
  const draftSaver = useMemo(() => (batch ? { onSave: batch.onSubmit, blocked: null, busy: batch.busy } : keeps), [batch, keeps]);
  // What Enter does; Cmd/Ctrl+Enter does the other where the box offers both.
  const enterAction: BoxAction = batch || keeps?.enterSaves ? "draft" : "post";
  const send = useCallback(async (action: BoxAction): Promise<ArtifactCommentBoxKeep> => {
    if (waiting || sending) return "busy";
    if (!comments || empty || !mayPost()) return "unavailable";
    if (action === "draft" && (!draftSaver || draftSaver.blocked || draftSaver.busy)) return "unavailable";
    if (hold) {
      hold();
      return "unavailable";
    }
    const id = comments.data.card.id;
    setSending(true);
    setError(null);
    // An edit's box goes once saved, and focus with it (its comment's ⋯): still wanted when the server answers?
    const saved = mode.kind === "edit" && onDone ? watchFocusIntent() : undefined;
    try {
      if (action === "draft" && draftSaver) {
        const byKey = new Map(picked.map((a) => [actorKey(a), a]));
        await draftSaver.onSave(body.flatMap((part): ArtifactCommentPart[] => {
          if (part.type === "text") return [part];
          const actor = byKey.get(actorKey(part.actor));
          return actor ? [{ type: "mention", actor }] : [];
        }), images.ready.map((image) => image.fileId));
        discardLocal();
        images.clear();
        setKeptUntouched(false);
        tellOwnText("");
        setText("");
        setPicked([]);
        dismiss();
      } else if (mode.kind === "edit") {
        comments.replaced((await artifactSource().editComment(id, mode.comment.id, body)).comment);
        discardLocal();
      } else {
        const replyTo = mode.replyTo;
        // A reply goes where its thread is.
        const target: ArtifactWebCommentInput["target"] = replyTo ? replyTo.target : mode.target;
        const at = eventServer();
        const created = await artifactSource().postComment(id, { body, version: comments.data.card.version, target, replyTo: replyTo?.id ?? null, ...imagesInput(images.ready) });
        trackArtifactCommentPosted({
          anchor: commentAnchorOf(target),
          isReply: replyTo !== null,
          mentions: body.filter((part) => part.type === "mention").length,
        }, at);
        if (revealSent) comments.revealSent(created.comment, revealSent === "list" ? null : revealSent);
        else comments.added(created.comment);
        discardLocal();
        images.clear();
        setKeptUntouched(false);
        tellOwnText("");
        setText("");
        setPicked([]);
        dismiss();
      }
      onDone?.(saved);
      return "kept";
    } catch (caught) {
      saved?.();
      const code = artifactErrorCode(caught);
      if (code === "DRAFT_LIMIT") {
        setError({ kind: "draftLimit", limit: artifactErrorDetails(caught, "DRAFT_LIMIT")?.limit ?? ARTIFACT_DRAFT_MAX_PER_ARTIFACT });
      } else if (code === "FIELD_TOO_LONG") {
        setError({ kind: "tooLong", limit: artifactErrorDetails(caught, "FIELD_TOO_LONG")?.limit ?? null });
      } else if (code === "MENTION_NOT_VISIBLE") {
        setError({ kind: "mentionNotVisible", actors: artifactErrorDetails(caught, "MENTION_NOT_VISIBLE")?.actors ?? [] });
      } else if (code === "TOO_MANY_MENTIONS") {
        setError({ kind: "tooManyMentions", limit: artifactErrorDetails(caught, "TOO_MANY_MENTIONS")?.limit ?? ARTIFACT_COMMENT_MAX_MENTIONS });
      } else if (!(code === "IMAGE_NOT_FOUND" && images.expireFile(artifactErrorDetails(caught, "IMAGE_NOT_FOUND")?.fileId ?? null))) {
        // An image gone since it was uploaded (an hour unclaimed) shows as expired, to remove.
        setError({ kind: "failed", draft: action === "draft" });
      }
      return "failed";
    } finally {
      setSending(false);
    }
  }, [comments, empty, waiting, sending, mayPost, hold, mode, body, onDone, tellOwnText, dismiss, draftSaver, picked, revealSent, discardLocal, images]);

  // The form's submit is its submit button's: Send, or the one action of a box that only keeps drafts.
  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(batch ? "draft" : "post");
  }, [send, batch]);
  const saveDraft = useCallback(() => { void send("draft"); }, [send]);
  // A card closing with the person's words keeps them as a draft (keepRef): a new comment's only.
  useLayoutEffect(() => {
    if (!keepRef) return;
    keepRef.current = mode.kind === "new" && keeps ? () => send("draft") : null;
    return () => { keepRef.current = null; };
  }, [keepRef, mode.kind, keeps, send]);

  const keyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented || isInputMethodKey(event)) return;
    // An open picker takes Esc, Enter, Tab and the arrows first.
    if (pickerKeyDown(event, pick)) return;
    // The other action on ⌘Enter / Ctrl+Enter, or the person's keys for it (registry "comment-other-action").
    if (keeps && !phone && matchesShortcut(event, "comment-other-action")) {
      event.preventDefault();
      void send(enterAction === "draft" ? "post" : "draft");
    } else if (event.key === "Enter" && !event.shiftKey && !phone) {
      // Armed, Enter is still no new line: it does nothing.
      event.preventDefault();
      void send(enterAction);
    } else if (event.key === "Escape" && (mode.kind === "edit" || batch || mode.replyTo) && onCancel) {
      // The box's own key either way. Nothing typed: it goes. Typed words stay, in view (Cancel or × drops them).
      event.preventDefault();
      if (!typed) onCancel();
    }
  }, [pickerKeyDown, pick, phone, send, enterAction, keeps, mode, batch, onCancel, typed]);

  // Cancel in the toolbar's start, beside Save Draft and Send: every box that can be left but a reply,
  // whose "Replying to" line has its ×.
  const toolbarCancel = onCancel !== undefined && !(mode.kind === "new" && mode.replyTo);
  const label = formatMessage({ id: mode.kind === "edit" ? "artifacts.comments.editLabel" : mode.kind === "new" && mode.replyTo ? "artifacts.comments.replyLabel" : "artifacts.comments.boxLabel" });
  // The page wrote the text it started with: said beside it until the person edits it.
  const pageNote = pageDraft !== null && !edited && text.trim() !== "";
  // Who is told: the send button's tooltip and the field's description, never a line under the box.
  const notifyText = mode.kind === "new"
    ? serverRecipients === null ? null : willNotifyText(recipients, intl)
    : editRecipients.length > 0 ? willNotifyText(editRecipients, intl) : null;
  const describedBy = [pageNote ? pageNoteId : null, error ? errorId : null, notifyText ? notifyId : null].filter(Boolean).join(" ") || undefined;
  const withNotify = (button: ReactElement) => (notifyText ? <Tooltip content={notifyText}>{button}</Tooltip> : button);
  // In a bottom sheet on a phone (no tooltip on touch), the sheet's description says it instead.
  const tellSheet = useContext(SheetNotifyContext);
  const sheetNotify = phone && mode.kind === "new" ? notifyText : null;
  useEffect(() => {
    if (!tellSheet) return;
    tellSheet(sheetNotify);
    return () => tellSheet(null);
  }, [tellSheet, sheetNotify]);
  const offDraft = !!draftSaver?.blocked || !!draftSaver?.busy;

  const toastFloor = useToastViewportFloor();
  return (
    <div
      // A floor for the app's toast (toastViewportBottom): a toast sits above the box, never over its Save Draft (wider than a phone, only where the box reaches the page's bottom).
      ref={toastFloor}
      className="flex flex-col gap-1.5"
      data-testid={mode.kind === "edit" ? "artifact-comment-edit-box" : "artifact-comment-box"}
      data-arming={arming || undefined}
      data-artifact-typed={typed || undefined}
      onPointerDownCapture={notePress}
      onKeyDownCapture={noteKey}
    >
      {mode.kind === "new" && mode.replyTo ? (
        <div className="flex items-center gap-1 text-footnote text-foreground-muted" data-testid="artifact-comment-replying">
          <span className="min-w-0 truncate">{formatMessage({ id: "artifacts.comments.replyingTo" }, { name: artifactActorName(mode.replyTo.author, formatMessage) })}</span>
          {onCancel ? (
            <Button variant="ghost" size="icon-md" aria-label={formatMessage({ id: "artifacts.comments.cancelReply" })} onClick={cancel}>
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}
      {pageNote ? (
        <p id={pageNoteId} className="text-footnote text-foreground-muted" data-testid="artifact-comment-page-draft">
          {formatMessage({ id: "artifacts.comments.pageDraft" })}
        </p>
      ) : null}
      <CommentImageRefusedBanner refused={images.refused} onDismiss={images.dismissRefused} size={standing ? "md" : "sm"} />
      <ComposerRoot onSubmit={submit} className="relative" {...drop.handlers}>
        {drop.dragging ? <CommentImageDropOverlay /> : null}
        <MentionSuggestionList picker={picker} onSelect={pick} testId="artifact-mention-picker" optionTestId={mentionOptionTestId} />
        <CommentImageChips artifactId={artifactId} items={images.items} onRemove={images.remove} onRetry={images.retry} />
        <KeptCommentImages artifactId={artifactId} images={keptImages} />
        <Composer>
          <ComposerInput
            {...{
              ...picker.listbox?.inputProps,
              ref: inputRef,
              value: text,
              onChange: changed,
              onSelect: selected,
              onFocus: focused,
              onBlur: blurred,
              onKeyDown: keyDown,
              onPaste: pasted,
              tabIndex: hold ? -1 : undefined,
              placeholder: formatMessage({ id: mode.kind === "new" && mode.replyTo ? "artifacts.comments.replyPlaceholder" : "artifacts.comments.placeholder" }),
              "aria-label": label,
              "aria-describedby": describedBy,
              "aria-invalid": error && error.kind !== "failed" ? true : undefined,
              rows: 1,
            }}
            data-testid="artifact-comment-input"
          />
          <ComposerToolbar>
            <ComposerActions className="min-w-0">
              {attachable ? <CommentImageAttachButton onFiles={images.add} /> : null}
              {toolbarCancel ? (
                <Button variant="ghost" size="md" onClick={cancel} data-testid="artifact-comment-cancel">{formatMessage({ id: "artifacts.comments.cancel" })}</Button>
              ) : null}
            </ComposerActions>
            <ComposerMeta className="ms-auto">
              {batch ? (
                <Button
                  type="submit"
                  variant="outline"
                  size="md"
                  disabled={empty || waiting || sending || !theirs || offDraft}
                  data-testid="artifact-comment-save-edit"
                >
                  {batch.label}
                </Button>
              ) : keeps ? (
                <>
                  {/* What Enter does is the pink one. */}
                  <Button
                    type="button"
                    variant={keeps.enterSaves ? "primary" : "outline"}
                    size="md"
                    onClick={saveDraft}
                    disabled={empty || waiting || sending || arming || !theirs || offDraft}
                    data-testid="artifact-comment-save-draft"
                    data-enter={keeps.enterSaves ? "" : undefined}
                  >
                    {formatMessage({ id: "artifacts.review.saveDraft" })}
                  </Button>
                  {withNotify(
                    <Button
                      type="submit"
                      variant={keeps.enterSaves ? "outline" : "primary"}
                      size="md"
                      disabled={empty || waiting || sending || arming || !theirs}
                      data-testid="artifact-comment-send"
                      data-enter={keeps.enterSaves ? undefined : ""}
                    >
                      {formatMessage({ id: "artifacts.comments.send" })}
                    </Button>,
                  )}
                </>
              ) : withNotify(
                <ComposerSubmit
                  size="icon-md"
                  aria-label={formatMessage({ id: mode.kind === "edit" ? "artifacts.comments.save" : "artifacts.comments.send" })}
                  disabled={empty || waiting || sending || arming || !theirs}
                  data-testid="artifact-comment-send"
                >
                  <ArrowUp />
                </ComposerSubmit>,
              )}
            </ComposerMeta>
          </ComposerToolbar>
        </Composer>
      </ComposerRoot>
      {mentioned.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={formatMessage({ id: "artifacts.comments.mentionsLabel" })} data-testid="artifact-comment-mentions">
          {mentioned.map((actor) => {
            const bad = invalid?.has(actorKey(actor)) ?? false;
            return (
              <li key={actorKey(actor)}>
                <Badge
                  appearance="soft"
                  variant={bad ? "danger" : "muted"}
                  aria-invalid={bad || undefined}
                  data-testid={`artifact-mention-chip-${actor.id}`}
                  data-invalid={bad || undefined}
                >
                  {mentionToken(actor)}
                </Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-footnote text-danger-strong" data-testid="artifact-comment-error">
          {error.kind === "draftLimit"
            ? formatMessage({ id: "artifacts.review.draftLimit" }, { limit: error.limit })
            : error.kind === "tooLong"
            ? error.limit
              ? formatMessage({ id: "artifacts.comments.errorTooLong" }, { limit: error.limit })
              : formatMessage({ id: "artifacts.comments.errorTooLongNoLimit" })
            : error.kind === "mentionNotVisible"
              ? formatMessage(
                { id: "artifacts.comments.errorMentionNotVisible" },
                // Names of the refused who are still mentioned (never ids); the error is gone once none is.
                { names: formatNameList(intl, invalidMentioned.map((a) => a.displayName)), count: invalidMentioned.length },
              )
              : error.kind === "tooManyMentions"
                ? formatMessage({ id: "artifacts.comments.tooManyMentions" }, { limit: error.limit })
                : formatMessage({ id: error.draft ? "artifacts.review.draftFailed" : "artifacts.comments.errorFailed" })}
        </p>
      ) : null}
      <CommentImageUnresolvedNote items={images.items} refused={images.refused} />
      {draftSaver?.blocked ? (
        <p className="text-footnote text-foreground-muted" data-testid="artifact-comment-batch-full">{draftSaver.blocked}</p>
      ) : null}
      {/* The send button's tooltip, for assistive tech as the field's description. */}
      {notifyText ? <p id={notifyId} className="sr-only" data-testid="artifact-will-notify">{notifyText}</p> : null}
    </div>
  );
}
