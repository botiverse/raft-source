import { useCallback, useMemo, useRef, useState } from "react";
import type { Ref, RefObject } from "react";
import { useIntl } from "react-intl";
import {
  ArrowUpRight,
  Code,
  Download,
  EllipsisVertical,
  Files,
  Flag,
  FolderDown,
  Forward,
  Link,
  MonitorSmartphone,
  Pencil,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
  PanelAction,
} from "@botiverse/raft-ui";
import {
  AddCommentIcon,
  CommentIcon,
  FollowArtifactIcon,
  UnfollowArtifactIcon,
} from "@botiverse/ricons";
import type { ArtifactHome, ArtifactViewerData } from "@botiverse/raft-shared";

import ConfirmDialog from "../../components/ConfirmDialog";
import Tooltip from "../../components/ui/Tooltip";
import { showToast } from "../../components/toastBridge";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useArtifactsEmbedOrigin } from "../../store/artifactsEmbedOrigin";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactErrorCode } from "./artifactApi";
import { artifactEmbedCode, copyTextLater, offersEmbed } from "./artifactEmbed";
import type { LaterCopy } from "./artifactEmbed";
import { artifactUrl } from "./artifactLinks";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { artifactSource, deleteArtifactHere, renameArtifactHere } from "./artifactSource";
import { useArtifactDownload } from "./artifactDownloads";
import { ArtifactScopeMenuItem, ArtifactVisibilityOptions, artifactVisibility } from "./ArtifactScopeLabel";
import type { ArtifactVisibility } from "./ArtifactScopeLabel";
import { artifactShareHost, artifactShareNoteKey } from "./artifactShareHost";
import { startArtifactForkNote } from "./artifactForkInRaft";
import { ArtifactNarrowHomeDialogs, homeRefusalMessage, isStaleHomeRefusal } from "./ArtifactNarrowHome";
import type { ArtifactHomeConfirmation } from "./ArtifactNarrowHome";
import { currentArtifactServerName } from "./artifactServerName";
import { ArtifactRenameDialog } from "./ArtifactRenameDialog";
import { ArtifactVersionHistoryMenuItem } from "./ArtifactVersionHistory";
import { artifactOpenLabelId, openArtifactWindow } from "./artifactWindow";
import type { PickVersion } from "./ArtifactVersionHistory";
import { ColumnMoveMenuItems } from "../../components/layout/appPanelHead";
import { readsAsOutsider, readsInOwnServer } from "./artifactOwnServer";
import { artifactAbuseHref } from "./artifactAbuseReport";
import { ArtifactHostMenuItems } from "./artifactHostMenu";

// The ⋯ menu's actions and the dialogs they open, one copy for both places an
// Artifact is read signed in: the in-app viewer (ArtifactViewer: the side
// card, expanded, a phone page) and its own page (ArtifactStandalonePage,
// `/artifacts/<id>`; #proj-workspace:#79). What it offers comes from the
// viewer data's capabilities alone, never from which of them draws it: a
// reader who may only read it (an outsider) gets fewer items on either.

/** What turning off link sharing (unpublish) says when the server refused it, by its code. */
function unpublishRefusal(code: string | null) {
  switch (code) {
    case "FORBIDDEN": return "artifacts.unpublish.forbidden";
    case "NOT_PUBLIC": return "artifacts.unpublish.notPublic";
    case "NAME_TAKEN": return "artifacts.unpublish.nameTaken";
    case "NOT_VISIBLE": return "artifacts.unpublish.notVisible";
    default: return "artifacts.unpublish.failed";
  }
}

/** What a refused new title says, by the server's code. */
function renameRefusal(code: string | null) {
  switch (code) {
    case "FORBIDDEN": return "artifacts.rename.forbidden";
    case "NOT_VISIBLE": return "artifacts.unpublish.notVisible";
    default: return "artifacts.rename.failed";
  }
}

/** What a write's answer changed, on the data it was made on and the version shown then. */
interface WriteAnswer {
  on: ArtifactViewerData;
  shownKey: string;
  home: ArtifactHome;
  capabilities?: ArtifactViewerData["capabilities"];
  /** Where a narrowing may take it now (#75): it follows the home and the capabilities. Absent: the data's. */
  originalHome?: ArtifactViewerData["originalHome"];
}

/** What a viewer-shaped answer (the home, unpublish and viewer routes) changes on the data shown. */
function viewerWrite(next: ArtifactViewerData): Pick<WriteAnswer, "home" | "capabilities" | "originalHome"> {
  return { home: next.card.home, capabilities: next.capabilities, originalHome: next.originalHome ?? null };
}

/**
 * Renaming it from ⋯'s Rename Artifact (task #147): the Rename Artifact dialog
 * (ArtifactRenameDialog, #proj-workspace:#169; the header's title is only
 * read).
 */
export interface ArtifactRename {
  /** The Rename Artifact dialog is open. */
  open: boolean;
  start: () => void;
  /** Close it, nothing sent. */
  cancel: () => void;
  /**
   * Send this title (trimmed; blank or the same only closes it). Saved: the header shows the
   * server's title and the dialog closes. Refused: the words that say why (renameRefusal), for the
   * dialog to show; never rejects.
   */
  save: (title: string) => Promise<string | null>;
}

export interface ArtifactViewerActions {
  /** The data as shown: the viewer data with what this reader's writes changed (home, capabilities). */
  view: ArtifactViewerData | null;
  /** What this reader may move it to; null: no Visibility (the chip and ⋯'s, one rule). */
  visibility: ArtifactVisibility | null;
  following: boolean;
  toggleFollow: () => void;
  openShare: () => void;
  /** Fork in Raft (#proj-workspace:#140): the same dialog, its note started with Fork's words where none is written. */
  openFork: () => void;
  askDelete: () => void;
  /** Where it lives now and what this reader may do there, read again. */
  readHomeAgain: () => void;
  /** Renaming it (⋯'s Rename and its Rename Artifact dialog); null where the reader may not (`capabilities.publish`). */
  rename: ArtifactRename | null;
  /**
   * ⋯'s Embed (#proj-workspace:#260, artifactEmbed.ts): a public Artifact's embed code copied; on one this reader
   * may make public, the turn-on-link-sharing confirmation first, then the code copied. Null where it isn't offered
   * (embeds off, a kind the embed page doesn't frame, or not public and the reader may not make it so).
   */
  embed: (() => void) | null;
  /** The dialogs' state, for ArtifactViewerDialogs. */
  dialogs: {
    sharing: boolean;
    closeSharing: () => void;
    handleShared: (home: ArtifactHome) => void;
    /** The home change being confirmed: a smaller home (previewed), unpublish, or public. */
    narrowing: ArtifactHomeConfirmation | null;
    closeNarrowing: () => void;
    narrowed: (next: ArtifactViewerData) => void;
    unpublishNow: () => Promise<void>;
    widenPublicNow: () => Promise<void>;
    /** The public confirmation is Embed's: it says what anyone with the link gets, and confirming copies the code. */
    embedding: boolean;
    confirmDelete: boolean;
    cancelDelete: () => void;
    confirmDeleteNow: () => Promise<void>;
  };
}

/**
 * The ⋯ menu's writes over the viewer data (follow, send, visibility,
 * rename, delete): what their answers changed is kept on the data they were
 * made on and the version shown then (`shownKey`), so a write answered after
 * another version loaded is dropped. `onDeleted`: where to go once it is deleted
 * (the side card closes; the page goes back to the server).
 */
export function useArtifactViewerActions(data: ArtifactViewerData | null, shownKey: string, onDeleted: () => void): ArtifactViewerActions {
  const { formatMessage } = useIntl();
  const [written, setWritten] = useState<WriteAnswer | null>(null);
  const [followChange, setFollowChange] = useState<boolean | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** A home change being confirmed (a smaller home's preview dialog, unpublish, public), or none. */
  const [narrowing, setNarrowing] = useState<ArtifactHomeConfirmation | null>(null);
  /** The `public` confirmation open is Embed's (copy the code once link sharing is on). */
  const [embedding, setEmbedding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** The title this reader gave it, on the data it was given on, as `written`. */
  const [retitled, setRetitled] = useState<{ on: ArtifactViewerData; shownKey: string; title: string } | null>(null);
  const view = useMemo(() => {
    const moved = data && written && written.on === data && written.shownKey === shownKey
      ? {
        ...data,
        card: { ...data.card, home: written.home },
        capabilities: written.capabilities ?? data.capabilities,
        originalHome: written.originalHome !== undefined ? written.originalHome : data.originalHome,
      }
      : data;
    return moved && retitled && retitled.on === data && retitled.shownKey === shownKey ? { ...moved, card: { ...moved.card, title: retitled.title } } : moved;
  }, [data, written, retitled, shownKey]);
  const writeOn = useCallback((on: ArtifactViewerData | null, requestKey: string) => (change: Pick<WriteAnswer, "home" | "capabilities" | "originalHome">) => {
    if (on) setWritten({ on, shownKey: requestKey, ...change });
  }, []);
  const id = view?.card.id ?? null;
  const following = followChange ?? view?.following ?? false;
  const toggleFollow = useCallback(() => {
    if (!id) return;
    trackArtifactViewerAction(following ? "unfollow" : "follow");
    void artifactSource().setFollowing(id, !following).then((answer) => setFollowChange(answer.following), () => {});
  }, [id, following]);
  /**
   * Where it lives now and what this viewer may do there, read again: after a move whose answer
   * says only the home (a share), and after a refusal that says the shown home is out of date.
   */
  const readHomeAgain = useCallback(() => {
    if (!id) return;
    const write = writeOn(data, shownKey);
    void artifactSource().viewer({ id, version: null }).then((result) => {
      if (result.status === "ok") write(viewerWrite(result.data));
    }, () => {});
  }, [id, data, shownKey, writeOn]);
  /** Settles true once the server moved it, false on a refusal (which says why itself). */
  const widen = useCallback((to: "server" | "public"): Promise<boolean> => {
    if (!id) return Promise.resolve(false);
    const write = writeOn(data, shownKey);
    // No preview here: the server only widens without `expectedLost`, so a choice made on a stale
    // chip (the home moved meanwhile) is HOME_NOT_WIDER, never a narrowing nobody confirmed.
    // A refusal leaves the home as it is and says why; a stale one shows the home it has now.
    return artifactSource().changeHome(id, { to }).then((next) => {
      write(viewerWrite(next));
      return next.card.home.kind === to;
    }, (error: unknown) => {
      showToast({ title: homeRefusalMessage(formatMessage, error), type: "error" });
      if (isStaleHomeRefusal(error)) readHomeAgain();
      return false;
    });
  }, [id, data, shownKey, writeOn, formatMessage, readHomeAgain]);
  const narrowed = useCallback((next: ArtifactViewerData) => {
    writeOn(data, shownKey)(viewerWrite(next));
    setNarrowing(null);
    setEmbedding(false);
  }, [data, shownKey, writeOn]);
  const closeNarrowing = useCallback(() => {
    setNarrowing(null);
    setEmbedding(false);
  }, []);
  const unpublish = useCallback((): Promise<void> => {
    if (!id) return Promise.resolve();
    const write = writeOn(data, shownKey);
    return artifactSource().unpublish(id).then((next) => write(viewerWrite(next)), (error: unknown) => {
      const code = artifactErrorCode(error);
      showToast({ title: formatMessage({ id: unpublishRefusal(code) }, currentArtifactServerName()), type: "error" });
      // Link sharing off already (moved meanwhile): show where it lives now.
      if (code === "NOT_PUBLIC") {
        void artifactSource().viewer({ id, version: null }).then((result) => {
          if (result.status === "ok") write(viewerWrite(result.data));
        }, () => {});
      }
    });
  }, [id, formatMessage, data, shownKey, writeOn]);
  const shownTitle = view?.card.title ?? null;
  const startRename = useCallback(() => setRenaming(true), []);
  const cancelRename = useCallback(() => setRenaming(false), []);
  const saveTitle = useCallback(async (next: string): Promise<string | null> => {
    const title = next.trim();
    if (!id || !data || title === "" || title === shownTitle) {
      setRenaming(false);
      return null;
    }
    const shown = { on: data, shownKey };
    try {
      // Not shown before the server takes it: the dialog stays, saving, until it answers.
      const answer = await renameArtifactHere(id, title);
      setRetitled({ ...shown, title: answer.card.title });
      setRenaming(false);
      return null;
    } catch (error: unknown) {
      return formatMessage({ id: renameRefusal(artifactErrorCode(error)) });
    }
  }, [id, data, shownKey, shownTitle, formatMessage]);
  const mayRename = view?.capabilities.publish === true;
  const rename = useMemo<ArtifactRename | null>(
    () => (mayRename ? { open: renaming, start: startRename, cancel: cancelRename, save: saveTitle } : null),
    [mayRename, renaming, startRename, cancelRename, saveTitle],
  );
  const askDelete = useCallback(() => setConfirmDelete(true), []);
  const openShare = useCallback(() => {
    trackArtifactViewerAction("share_open");
    setSharing(true);
  }, []);
  const openFork = useCallback(() => {
    if (id) startArtifactForkNote(artifactShareNoteKey(id), formatMessage);
    openShare();
  }, [id, formatMessage, openShare]);
  const capabilities = view?.capabilities;
  const closeSharing = useCallback(() => setSharing(false), []);
  const handleShared = useCallback((home: ArtifactHome) => {
    // Sending with a larger home moved it first: the viewer shows where it lives now, then what
    // this viewer may do there (the capabilities follow the home; the share's answer has only it).
    writeOn(data, shownKey)({ home, capabilities });
    readHomeAgain();
  }, [data, shownKey, capabilities, writeOn, readHomeAgain]);
  const cancelDelete = useCallback(() => setConfirmDelete(false), []);
  const confirmDeleteNow = useCallback(async () => {
    if (!id) return;
    await deleteArtifactHere(id);
    onDeleted();
  }, [id, onDeleted]);
  // Anyone with the link is a wider audience than the server: it asks first (Raft DS › Feedback,
  // "Confirming"); the whole server is within it and applies at once.
  const askWiden = useCallback((to: "server" | "public") => {
    setEmbedding(false);
    if (to === "public") setNarrowing("public");
    else void widen("server");
  }, [widen]);
  // Link sharing off through unpublish asks as the previewed narrowing does, from either route.
  const askUnpublish = useCallback(() => setNarrowing("unpublish"), []);
  // ⋯'s Embed: the code for this Artifact (its id and the title shown), copied with the app's toast.
  const embedOrigin = useArtifactsEmbedOrigin();
  const embedOffer = view ? offersEmbed(embedOrigin, view) : null;
  const embedCode = embedOrigin && view ? artifactEmbedCode(embedOrigin, view.card.id, view.card.title) : null;
  // A copy the browser blocked is a warning (Raft DS feedback.md), not an error; counted only once copied.
  const copiedEmbed = useCallback((result: LaterCopy) => {
    if (result === "copied") {
      trackArtifactViewerAction("embed_copy");
      showToast({ title: formatMessage({ id: "artifacts.menu.embedCopied" }), type: "success" });
    } else if (result === "failed") showToast({ title: formatMessage({ id: "artifacts.frame.copyFailed" }), type: "warning" });
  }, [formatMessage]);
  const embed = useMemo(() => {
    if (embedOffer === null || embedCode === null) return null;
    return () => {
      if (embedOffer === "copy") {
        // In the click: the code is known now.
        void copyTextToClipboard(embedCode).then(() => "copied" as const, () => "failed" as const).then(copiedEmbed);
      } else {
        // Not public yet: the turn-on-link-sharing confirmation, as Who can see's, Embed's words in it.
        setEmbedding(true);
        setNarrowing("public");
      }
    };
  }, [embedOffer, embedCode, copiedEmbed]);
  const widenPublicNow = useCallback(async () => {
    if (!embedding || embedCode === null) {
      await widen("public");
      return;
    }
    // Embed's confirmation: the clipboard write starts in the confirm's click (copyTextLater), its
    // text the code once anyone with the link can open it; a refusal said why, and nothing is copied.
    const code = embedCode;
    const shared = widen("public");
    const copied = copyTextLater(shared.then((ok) => (ok ? code : null)));
    await shared;
    copiedEmbed(await copied);
  }, [widen, embedding, embedCode, copiedEmbed]);
  // One set of visibility rules for the chip a manager clicks and the ⋯ menu.
  const visibility = useMemo(
    () => (view ? artifactVisibility(view, { onWiden: askWiden, onUnpublish: askUnpublish, onNarrow: setNarrowing }) : null),
    [view, askWiden, askUnpublish],
  );
  // One object while nothing in it changed: the surface's context (and everything reading it) keeps it.
  return useMemo(() => ({
    view,
    visibility,
    following,
    toggleFollow,
    openShare,
    openFork,
    askDelete,
    readHomeAgain,
    rename,
    embed,
    dialogs: { sharing, closeSharing, handleShared, narrowing, closeNarrowing, narrowed, unpublishNow: unpublish, widenPublicNow, embedding, confirmDelete, cancelDelete, confirmDeleteNow },
  }), [view, visibility, following, toggleFollow, openShare, openFork, askDelete, readHomeAgain, rename, embed, sharing, closeSharing, handleShared, narrowing, closeNarrowing, narrowed, unpublish, widenPublicNow, embedding, confirmDelete, cancelDelete, confirmDeleteNow]);
}

/** What ⋯'s items open: Send to conversation, a smaller home's confirmation, Rename Artifact, Delete's. */
export function ArtifactViewerDialogs({ data, actions, finalFocus, menuFocus }: {
  data: ArtifactViewerData;
  actions: ArtifactViewerActions;
  /** Where focus goes back when a narrowing dialog closes: the meta line's scope label (a button on both shells). */
  finalFocus: RefObject<HTMLElement | null>;
  /** Where focus goes back when Rename Artifact closes: ⋯, which opened it. */
  menuFocus: RefObject<HTMLElement | null>;
}) {
  const { formatMessage } = useIntl();
  const { dialogs, readHomeAgain, rename } = actions;
  // Core's Forward dialog, with this Artifact as what it forwards (#proj-workspace:#99).
  const { ForwardDialog } = artifactShareHost();
  return (
    <>
      {dialogs.sharing ? (
        <ForwardDialog data={data} onClose={dialogs.closeSharing} onShared={dialogs.handleShared} onStale={readHomeAgain} />
      ) : null}
      <ArtifactNarrowHomeDialogs
        to={dialogs.narrowing}
        data={data}
        finalFocus={finalFocus}
        onClose={dialogs.closeNarrowing}
        onMoved={dialogs.narrowed}
        onStale={readHomeAgain}
        onUnpublish={dialogs.unpublishNow}
        onWidenPublic={dialogs.widenPublicNow}
        embed={dialogs.embedding}
      />
      {/* Mounted per opening: its field starts from the title shown then. */}
      {rename?.open ? <ArtifactRenameDialog title={data.card.title} rename={rename} finalFocus={menuFocus} /> : null}
      {dialogs.confirmDelete ? (
        <ConfirmDialog
          title={formatMessage({ id: "artifacts.delete.title" })}
          message={formatMessage({ id: "artifacts.delete.body" }, { title: data.card.title })}
          confirmLabel={formatMessage({ id: "artifacts.menu.delete" })}
          onConfirm={dialogs.confirmDeleteNow}
          onClose={dialogs.cancelDelete}
        />
      ) : null}
    </>
  );
}

/** Copies the Artifact's address (this deployment's origin; `/v/<n>` only when pinned) and says so in a toast, in every shell. */
export function useCopyArtifactLink(card: ArtifactViewerData["card"]): () => void {
  const { formatMessage } = useIntl();
  // Built from the id, never taken from the payload.
  const url = artifactUrl(card.id, card.pinned ? card.version : null);
  return useCallback(() => {
    trackArtifactViewerAction("copy_link");
    void navigator.clipboard?.writeText(url).then(
      () => showToast({ title: formatMessage({ id: "artifacts.menu.linkCopied" }), type: "success" }),
      () => {},
    );
  }, [url, formatMessage]);
}

/** The side card's header pieces folded into ⋯ where it is narrow (the in-app viewer only). */
export interface ArtifactMenuFold {
  comments: { open: boolean; label: string; onOpenChange: (open: boolean) => void } | null;
  /**
   * Comment mode's head controls, folded where the head has no room (#189 rule 6): the Comment button (pressed in
   * comment mode), its ▾'s Show All Comments and Doesn't display well here (`reportDisplay`, where the reader may
   * comment: #proj-workspace:#243), and Retry where the head shows it.
   */
  review?: {
    commenting: boolean;
    label: string;
    onToggle: (pressed: boolean) => void;
    showAllLabel: string;
    onShowAll: () => void;
    retry: { label: string; onSelect: () => void } | null;
    reportDisplay: { label: string; onSelect: () => void } | null;
  } | null;
  /** Open in New Page, folded from the head (#189 rule 6: it folds like the head's other own actions). */
  openInNewPage?: boolean;
  /** The head's visibility chip, folded with them: ⋯'s Visibility where the reader can change it, else where it lives. */
  scope?: boolean;
  /** Fork in Raft (#proj-workspace:#140), where the header is compact: the menu's first item, not a labelled button. */
  fork?: { label: string; onSelect: () => void } | null;
  /** Find in page (artifactFind), folded from the head: it opens the find bar, whose field takes focus. */
  find?: { label: string; onSelect: () => void } | null;
}

/**
 * The ⋯ menu (F13): names only, and only what this reader may do. No
 * convert, duplicate or revert (W19–W21).
 *
 * `surface` is where it is drawn, and decides only what makes no sense
 * there: on the Artifact's own page ("page") there is no "Open in new page"
 * (it is that page) and nothing to expand (the page is the whole window);
 * Copy link is in its top bar, so here only where that bar folds it in (a
 * phone, `onCopyLink`). Everything else comes from the capabilities and
 * where it lives, the same on both.
 *
 * After what the head folded in, four groups, each two apart by a separator,
 * an empty one left out with its separator (#proj-workspace:#169, xxchan's
 * mockup): taking it elsewhere (Copy link, Embed, Send to conversation, Who
 * can see ›), the Artifact itself (Rename, Version history › but for another
 * server's reader, who reads the current version only, Files,
 * then Download, or Download all (one zip) for more than one file:
 * useArtifactDownload: none for another server's reader), this reader's own
 * (Follow or Unfollow, a member of the Artifact's own server's only: another
 * server's reader gets nothing from following it; Doesn't display well here
 * where the reader may comment but there is no comment mode, so no Comment
 * button's ▾ to hold it, Move Left / Move Right), then Delete. The menu is
 * the Artifact's own, so its items don't name it again
 * (Raft DS writing.md, "Actions and their dialogs", raft-design #1090); the
 * dialog an item opens may (Rename opens Rename Artifact, Delete asks "Delete
 * this Artifact?" and its red button says Delete Artifact). No trailing "…"
 * (Raft DS DropdownMenu, writing.md).
 *
 * No Copy for AI, Open in ChatGPT or Open in Claude here (xxchan): a
 * signed-in reader, of its own server or another, has their agents in Raft
 * to ask. Only the signed-out public page offers them (PublicArtifactAiActions).
 */
export function ArtifactViewerMenu({
  data,
  surface,
  visibility,
  following,
  onToggleFollow,
  onDelete,
  onSend,
  onCopyLink,
  onEmbed = null,
  onRename,
  onPickVersion,
  onOpenVersions,
  onOpenFiles = null,
  onReportDisplay = null,
  fold = null,
  triggerRef,
  phone: phoneLayout,
}: {
  data: ArtifactViewerData;
  surface: "viewer" | "page";
  /** What this viewer may move it to; null: no Visibility item. */
  visibility: ArtifactVisibility | null;
  following: boolean;
  onToggleFollow: () => void;
  onDelete: () => void;
  /** "Send to conversation" (F21); null: not in ⋯, the header has it as Fork in Raft (#proj-workspace:#140). */
  onSend: (() => void) | null;
  /** Copy link here; null: the surface has it elsewhere (the page's top bar). */
  onCopyLink: (() => void) | null;
  /** Embed (useArtifactViewerActions' `embed`), after where Copy link is; null or absent: not offered. */
  onEmbed?: (() => void) | null;
  /** Rename: opens Rename Artifact; null where the reader may not (no `capabilities.publish`). */
  onRename: (() => void) | null;
  onPickVersion: PickVersion;
  /** On a phone, Version history opens its sheet. */
  onOpenVersions: () => void;
  /** Files: opens the Files panel (every file of the version shown); null or absent: no Files item. */
  onOpenFiles?: (() => void) | null;
  /**
   * Doesn't display well here (#proj-workspace:#243): opens the comment list's box with what it measured
   * (useArtifactDisplayReport); null or
   * absent where the reader may not comment (`capabilities.comment`), or where it is the Comment button's ▾'s
   * (comment mode offered; folded in, it is `fold.review.reportDisplay`).
   */
  onReportDisplay?: (() => void) | null;
  fold?: ArtifactMenuFold | null;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Laid out as on a phone whatever the width (the App's WebView); unset: by the window's width. */
  phone?: boolean;
}) {
  const { formatMessage } = useIntl();
  const { card, capabilities } = data;
  // Rename, Doesn't display well here and Find in page hand focus to what they open (Rename Artifact, the comment
  // list's box, the find bar's field), and Files to the panel it opens: closing, the menu doesn't take it back to ⋯
  // (the dialog, or Esc in the panel, gives it back).
  const handsFocus = useRef(false);
  const rename = useCallback(() => {
    handsFocus.current = true;
    onRename?.();
  }, [onRename]);
  const openFiles = useCallback(() => {
    handsFocus.current = true;
    onOpenFiles?.();
  }, [onOpenFiles]);
  const reportDisplay = useCallback(() => {
    handsFocus.current = true;
    onReportDisplay?.();
  }, [onReportDisplay]);
  const foldedReport = fold?.review?.reportDisplay?.onSelect;
  const reportFolded = useCallback(() => {
    handsFocus.current = true;
    foldedReport?.();
  }, [foldedReport]);
  const foldedFind = fold?.find?.onSelect;
  const openFind = useCallback(() => {
    handsFocus.current = true;
    foldedFind?.();
  }, [foldedFind]);
  const finalFocus = useCallback(() => {
    const toTrigger = !handsFocus.current;
    handsFocus.current = false;
    return toTrigger;
  }, []);
  const phoneWidth = useMediaQuery(PHONE_QUERY);
  const phone = phoneLayout ?? phoneWidth;
  const moreLabel = formatMessage({ id: "artifacts.viewer.more" });
  const testId = surface === "page" ? "artifact-page-menu" : "artifact-viewer-menu";
  const download = useArtifactDownload(data);
  const openInNewPage = useCallback(() => {
    // Addresses are built from the id, never taken from the payload.
    openArtifactWindow(artifactUrl(card.id, card.pinned ? card.version : null), card.id);
  }, [card.id, card.pinned, card.version]);
  const review = fold?.review ?? null;
  const openHere = surface === "viewer" && (phone || !!fold?.openInNewPage);
  const scopeFolded = !!fold?.scope && !visibility;
  const folded = openHere || scopeFolded || review !== null || fold?.comments != null || fold?.find != null || fold?.fork != null;
  const shares = onCopyLink !== null || onEmbed !== null || onSend !== null || visibility !== null;
  // Another server's reader reads the current version only (the server's accessOf historyLimited: its versions
  // list just that one, any other is not found), so no Version history for them.
  const versionHistory = readsInOwnServer(card);
  const itself = !!onRename || versionHistory || (!!onOpenFiles && data.files.length > 0) || download !== null;
  // Follow is the Artifact's own server's (readsInOwnServer): another server's reader would follow nothing.
  const follow = readsInOwnServer(card);
  // What of the reader's own group this menu knows it draws; Move Left / Move Right are ColumnMoveMenuItems' to know.
  const own = follow || !!onReportDisplay;
  // Another server's reader of a public Artifact: Report abuse, last and apart, as on the public page (the Artifacts
  // feature matrix, xxchan and Kirby 2026-11-10): they have none of its server's people to tell. A mail naming the link.
  const reportAbuse = readsAsOutsider(card) ? artifactAbuseHref(artifactUrl(card.id), formatMessage({ id: "artifacts.public.reportSubject" })) : null;
  const reportAbuseLabel = formatMessage({ id: "artifacts.public.reportAbuse" });
  return (
    <DropdownMenu>
      <Tooltip content={moreLabel}>
        <DropdownMenuTrigger
          render={(
            <PanelAction ref={triggerRef} aria-label={moreLabel} data-testid={`${testId}-trigger`}>
              <EllipsisVertical />
            </PanelAction>
          )}
        />
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" sideOffset={4} finalFocus={finalFocus} aria-label={moreLabel} data-testid={testId}>
        {/* In the App, where it declared its own items, they come first: the page's bar is the only one (artifactHostMenu). */}
        {surface === "page" ? <ArtifactHostMenuItems /> : null}
        {/* Where the header is compact, its Fork in Raft is the first item: the one primary action, folded in
            (#proj-workspace:#140), so a long label never squeezes the title. */}
        {fold?.fork ? (
          <DropdownMenuItem onClick={fold.fork.onSelect} data-testid="artifact-viewer-menu-fork">
            <Forward />
            {fold.fork.label}
          </DropdownMenuItem>
        ) : null}
        {/* Where the head is narrow, its own actions come first here: the viewer's own toolbar, folded in, in the
            head's order (Expand never folds in). Open in new page is the page itself on the Artifact's own page; off
            a phone the viewer's is a header button beside Expand (ArtifactViewer) until the head folds it, and a
            phone's header has no room for it, so it is here. */}
        {openHere ? (
          <DropdownMenuItem onClick={openInNewPage} data-testid="artifact-viewer-menu-open-in-new-page">
            <ArrowUpRight />
            {formatMessage({ id: artifactOpenLabelId("artifacts.card.openInNewPage") })}
          </DropdownMenuItem>
        ) : null}
        {scopeFolded ? <ArtifactScopeMenuItem home={card.home} fromAnotherServer={card.fromAnotherServer} /> : null}
        {review?.retry ? (
          <DropdownMenuItem onClick={review.retry.onSelect} data-testid="artifact-viewer-menu-drafts-retry">
            {review.retry.label}
          </DropdownMenuItem>
        ) : null}
        {review ? (
          <>
            <DropdownMenuCheckboxItem checked={review.commenting} onCheckedChange={review.onToggle} closeOnClick data-testid="artifact-viewer-menu-comment">
              <AddCommentIcon />
              {review.label}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem onClick={review.onShowAll} data-testid="artifact-viewer-menu-show-all-comments">
              <CommentIcon />
              {review.showAllLabel}
            </DropdownMenuItem>
            {/* The ▾'s second item, folded with it: it posts a comment, so it stays with the comment controls. */}
            {review.reportDisplay ? (
              <DropdownMenuItem onClick={reportFolded} data-testid="artifact-viewer-menu-display-report">
                <MonitorSmartphone />
                {review.reportDisplay.label}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {fold?.comments ? (
          // It opens or closes the comments, so the menu closes too: left open, it covers the
          // panel it just opened on a phone or a narrow card (a Base UI checkbox item stays open by default).
          <DropdownMenuCheckboxItem
            checked={fold.comments.open}
            onCheckedChange={fold.comments.onOpenChange}
            closeOnClick
            data-testid="artifact-viewer-menu-comments"
          >
            <CommentIcon />
            {fold.comments.label}
          </DropdownMenuCheckboxItem>
        ) : null}
        {fold?.find ? (
          <DropdownMenuItem onClick={openFind} data-testid="artifact-viewer-menu-find">
            <Search />
            {fold.find.label}
          </DropdownMenuItem>
        ) : null}
        {folded ? <DropdownMenuSeparator /> : null}
        {/* Then four groups, a separator between each two (#proj-workspace:#169): taking it elsewhere, the
            Artifact itself, this reader's own, and Delete. An item that opens a dialog says the dialog's title, with no trailing "…". */}
        {onCopyLink ? (
          <DropdownMenuItem onClick={onCopyLink} data-testid={`${testId}-copy-link`}>
            <Link />
            {formatMessage({ id: "artifacts.menu.copyLink" })}
          </DropdownMenuItem>
        ) : null}
        {onEmbed ? (
          <DropdownMenuItem onClick={onEmbed} data-testid={`${testId}-embed`}>
            <Code />
            {formatMessage({ id: "artifacts.menu.embed" })}
          </DropdownMenuItem>
        ) : null}
        {onSend ? (
          <DropdownMenuItem onClick={onSend} data-testid="artifact-viewer-menu-send">
            <Forward />
            {formatMessage({ id: "artifacts.menu.sendToConversation" })}
          </DropdownMenuItem>
        ) : null}
        {visibility ? (
          <DropdownMenuSubmenu>
            <DropdownMenuSubmenuTrigger data-testid="artifact-viewer-menu-visibility">
              <Users />
              {formatMessage({ id: "artifacts.menu.visibility" })}
            </DropdownMenuSubmenuTrigger>
            <DropdownMenuContent side="left" align="start">
              <ArtifactVisibilityOptions visibility={visibility} />
            </DropdownMenuContent>
          </DropdownMenuSubmenu>
        ) : null}
        {shares && itself ? <DropdownMenuSeparator /> : null}
        {onRename ? (
          <DropdownMenuItem onClick={rename} data-testid={`${testId}-rename`}>
            <Pencil />
            {formatMessage({ id: "artifacts.menu.rename" })}
          </DropdownMenuItem>
        ) : null}
        {versionHistory ? <ArtifactVersionHistoryMenuItem data={data} phone={phone} onPick={onPickVersion} onOpenSheet={onOpenVersions} /> : null}
        {onOpenFiles && data.files.length > 0 ? (
          <DropdownMenuItem onClick={openFiles} data-testid="artifact-viewer-menu-files">
            <Files />
            {formatMessage({ id: "artifacts.menu.files" })}
          </DropdownMenuItem>
        ) : null}
        {download ? (
          // More than one file: all of them in one zip (an entry's images come with it); one: that file.
          <DropdownMenuItem onClick={download.download} data-testid="artifact-viewer-menu-download" data-download={download.all ? "zip" : "file"}>
            {download.all ? <FolderDown /> : <Download />}
            {formatMessage({ id: download.all ? "artifacts.menu.downloadAll" : "artifacts.menu.download" })}
          </DropdownMenuItem>
        ) : null}
        {/* The group's separator: before Follow or the display report; with neither, before the moves if there are any. */}
        {(shares || itself) && own ? <DropdownMenuSeparator /> : null}
        {follow ? (
          <DropdownMenuItem onClick={onToggleFollow} data-testid="artifact-viewer-menu-follow">
            {following ? <UnfollowArtifactIcon /> : <FollowArtifactIcon />}
            {formatMessage({ id: following ? "artifacts.menu.unfollow" : "artifacts.menu.follow" })}
          </DropdownMenuItem>
        ) : null}
        {/* With the reader's own, after Follow, where there is no comment mode (no Comment button's ▾, which has it
            otherwise): the page doesn't show well on their screen; it opens the comment list's box with what the
            viewer measured (#proj-workspace:#243). No hint anywhere else. */}
        {onReportDisplay ? (
          <DropdownMenuItem onClick={reportDisplay} data-testid="artifact-viewer-menu-display-report">
            <MonitorSmartphone />
            {formatMessage({ id: "artifacts.menu.displayReport" })}
          </DropdownMenuItem>
        ) : null}
        {/* In the row's column: Move Left / Move Right where it can move (#189 rule 7), this reader's layout. */}
        <ColumnMoveMenuItems region="artifact" lead={(shares || itself) && !own ? <DropdownMenuSeparator /> : undefined} />
        {capabilities.delete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} data-testid="artifact-viewer-menu-delete">
              <Trash2 />
              {formatMessage({ id: "artifacts.menu.deleteAsk" })}
            </DropdownMenuItem>
          </>
        ) : null}
        {reportAbuse ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<a href={reportAbuse} aria-label={reportAbuseLabel} />} data-testid="artifact-viewer-menu-report-abuse">
              <Flag />
              {reportAbuseLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
