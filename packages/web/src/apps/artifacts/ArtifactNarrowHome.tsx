import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
} from "@botiverse/raft-ui";
import { ARTIFACT_WEB_ERROR_CODES } from "@botiverse/raft-shared";
import type { ArtifactViewerData, ArtifactWebHomeChange } from "@botiverse/raft-shared";

import { trackArtifactConfirmDialogClosed } from "./artifactAnalytics";
import type { ArtifactConfirmDialog } from "./artifactAnalytics";
import { artifactErrorCode, artifactErrorDetails } from "./artifactApi";
import type { ArtifactHomeChangeTarget } from "./artifactApi";
import { artifactSource } from "./artifactSource";
import { artifactShareHost } from "./artifactShareHost";
import { conversationLabel } from "./artifactHomeWords";
import { useArtifactServerName } from "./artifactServerName";
import type { ArtifactServerName } from "./artifactServerName";

type FormatMessage = IntlShape["formatMessage"];

/**
 * What a refused home change says, by the home route's code and details
 * (webArtifactsContract `home`, `homeChange`; webCommon webManageRefusal):
 * one plain, specific sentence each. LOSS_CHANGED is not here: it asks
 * again with the new count (useNarrowing).
 */
export function homeRefusalMessage(formatMessage: FormatMessage, error: unknown): string {
  switch (artifactErrorCode(error)) {
    case "NOT_VISIBLE": return formatMessage({ id: "artifacts.home.notVisible" });
    case "TARGET_NOT_FOUND": return formatMessage({ id: "artifacts.home.targetNotFound" });
    case "FORBIDDEN": return formatMessage({ id: "artifacts.home.forbidden" });
    case "HOME_NOT_WIDER": return formatMessage({ id: "artifacts.home.notWider" });
    // Not its original conversation (#75): what the reader saw is out of date, as HOME_NOT_NARROWER.
    case "HOME_NOT_NARROWER":
    case "NOT_ORIGINAL_HOME": return formatMessage({ id: "artifacts.home.notNarrower" });
    case "TARGET_NOT_SUPPORTED":
      return formatMessage({ id: artifactErrorDetails(error, "TARGET_NOT_SUPPORTED")?.reason === "joint" ? "artifacts.home.notSupportedJoint" : "artifacts.home.notSupportedThread" });
    case "TARGET_HAS_GUESTS":
      return formatMessage({ id: artifactErrorDetails(error, "TARGET_HAS_GUESTS")?.reason === "open_to_guests" ? "artifacts.home.openToGuests" : "artifacts.home.guestMembers" });
    case "AUTHOR_LOSES_ACCESS":
      return formatMessage({ id: artifactErrorDetails(error, "AUTHOR_LOSES_ACCESS")?.reason === "agent_not_member" ? "artifacts.home.authorAgentNotMember" : "artifacts.home.authorCannotSee" });
    case "NAME_TAKEN": return formatMessage({ id: "artifacts.home.nameTaken" });
    case "INVALID_REQUEST": return formatMessage({ id: "artifacts.home.invalid" });
    case "RATE_LIMITED": return formatMessage({ id: "artifacts.home.rateLimited" });
    default: return formatMessage({ id: "artifacts.home.failed" });
  }
}

/**
 * A refusal that says the viewer's picture of the home is out of date
 * (moved, or who may move it changed, or it is gone): the caller reads the
 * viewer again so the chip and the capabilities show what the server has.
 * HOME_NOT_WIDER is also what the server answers a narrowing sent without
 * `expectedLost` (a chip choice made on a stale home: the server enforces
 * that a smaller home is only ever reached through the preview).
 * NOT_ORIGINAL_HOME: the conversation a narrowing may go back to isn't the
 * one the reader was shown (#75); read again, the viewer's `originalHome`
 * and `narrowHome` say what it may be now.
 */
export function isStaleHomeRefusal(error: unknown): boolean {
  const code = artifactErrorCode(error);
  return code === "HOME_NOT_NARROWER" || code === "NOT_ORIGINAL_HOME" || code === "HOME_NOT_WIDER" || code === "FORBIDDEN" || code === "NOT_VISIBLE";
}

/**
 * Where a narrowing's preview stands, for one target (the move in flight is
 * apart: `moving`, for whichever target, so nothing else can start then):
 * - `loading`: the preview is being asked (again, after LOSS_CHANGED);
 * - `ready`: the preview's counts, to confirm (`changed`: the count moved
 *   since it was first shown; `error`: the move failed, confirm may try again);
 * - `refused`: the preview or the move was refused (the message), or the
 *   preview failed (`retry`: Try again asks it again).
 */
type Narrowing =
  | { status: "loading" }
  | { status: "ready"; change: ArtifactWebHomeChange; changed: boolean; error: string | null }
  | { status: "refused"; message: string; retry: boolean };

/** An answer with one of the contract's codes (a refusal), not a failure to answer (offline, a 500's HTTP_ERROR). */
const isRefusal = (error: unknown): boolean => (ARTIFACT_WEB_ERROR_CODES as readonly string[]).includes(String(artifactErrorCode(error)));

const keyOf = (target: ArtifactHomeChangeTarget) => (target.to === "server" ? "server" : `conversation:${target.conversationId}`);

interface NarrowingCallbacks {
  onMoved: (data: ArtifactViewerData) => void;
  /** A stale-state refusal (isStaleHomeRefusal): read the viewer again. */
  onStale: () => void;
  /** The person pressed the confirm and the move starts (analytics). */
  onConfirmStart?: () => void;
}

/** True while a move is in flight: the dialog's root reads it to keep Esc and the scrim from closing then. */
type MovingRef = RefObject<boolean>;

/**
 * The preview for `target` (asked when it is shown, and again on Try again
 * or when the count changed), and the confirmed move: the home route with
 * `expectedLost` = the people and agents the shown preview says lose it.
 * One move at a time (`moving`, checked through a ref so a double click
 * can't send two); LOSS_CHANGED: the preview again, marked changed, to
 * confirm again. Closing drops every answer still on its way.
 */
function useNarrowing(id: ArtifactViewerData["card"]["id"], target: ArtifactHomeChangeTarget | null, callbacks: NarrowingCallbacks, movingRef: MovingRef) {
  const { formatMessage } = useIntl();
  const key = target ? keyOf(target) : null;
  const [answer, setAnswer] = useState<{ key: string; narrowing: Narrowing } | null>(null);
  const [moving, setMoving] = useState(false);
  /** Which ask is current: an older answer (another target, an earlier ask, a closed dialog) is dropped. */
  const asked = useRef(0);
  // The latest callbacks, so asking never waits on the parent's identities.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const preview = useCallback((to: ArtifactHomeChangeTarget, changed: boolean) => {
    const mine = ++asked.current;
    const at = keyOf(to);
    artifactSource().homeChange(id, to).then(
      (change) => { if (asked.current === mine) setAnswer({ key: at, narrowing: { status: "ready", change, changed, error: null } }); },
      (error: unknown) => {
        if (asked.current !== mine) return;
        if (isStaleHomeRefusal(error)) callbacksRef.current.onStale();
        // A refusal says why; anything else (offline, a 500) can be asked again.
        setAnswer({ key: at, narrowing: isRefusal(error)
          ? { status: "refused", message: homeRefusalMessage(formatMessage, error), retry: false }
          : { status: "refused", message: formatMessage({ id: "artifacts.narrow.previewFailed" }), retry: true } });
      },
    );
  }, [id, formatMessage]);

  // Fetching what the shown target would take away; a newer ask (or closing) drops the answer.
  useEffect(() => {
    if (!target) return;
    preview(target, false);
    return () => { asked.current += 1; };
  }, [target, preview]);

  const shown = answer && answer.key === key ? answer.narrowing : null;
  const narrowing: Narrowing | null = key ? shown ?? { status: "loading" } : null;

  const retry = useCallback(() => {
    if (!target || !key || movingRef.current) return;
    setAnswer({ key, narrowing: { status: "loading" } });
    preview(target, false);
  }, [target, key, preview, movingRef]);

  const confirm = useCallback(() => {
    if (!target || !key || movingRef.current || !answer || answer.key !== key || answer.narrowing.status !== "ready") return;
    callbacksRef.current.onConfirmStart?.();
    const { change, changed } = answer.narrowing;
    movingRef.current = true;
    setMoving(true);
    // Nothing asks while it moves (the picker and Try again are off); only closing moves this on.
    const mine = asked.current;
    const settle = () => { movingRef.current = false; setMoving(false); return asked.current === mine; };
    const expectedLost = change.peopleLosingAccess + change.agentsLosingAccess;
    artifactSource().changeHome(id, { ...target, expectedLost }).then((data) => {
      if (settle()) callbacksRef.current.onMoved(data);
    }, (error: unknown) => {
      if (!settle()) return;
      if (artifactErrorCode(error) === "LOSS_CHANGED") {
        // Someone joined or left meanwhile: the target asked again, shown checking until it answers.
        setAnswer({ key, narrowing: { status: "loading" } });
        preview(target, true);
        return;
      }
      if (isStaleHomeRefusal(error)) callbacksRef.current.onStale();
      // A refusal stops it, saying why; anything else (offline, a 500) may be confirmed again.
      setAnswer({ key, narrowing: isRefusal(error)
        ? { status: "refused", message: homeRefusalMessage(formatMessage, error), retry: false }
        : { status: "ready", change, changed, error: formatMessage({ id: "artifacts.home.failed" }) } });
    });
  }, [id, target, key, answer, preview, formatMessage, movingRef]);

  return { narrowing, moving, retry, confirm };
}

/** The count that would lose it, as the confirmation says it; null when nobody would (#250: no banner then). */
function lossText(formatMessage: FormatMessage, change: ArtifactWebHomeChange): string | null {
  const people = change.peopleLosingAccess;
  const agents = change.agentsLosingAccess;
  // Capped: only so many were checked, so the count is a lower bound.
  if (change.capped) return formatMessage({ id: "artifacts.narrow.losingCapped" }, { count: people + agents });
  if (people + agents === 0) return null;
  return formatMessage({ id: "artifacts.narrow.losing" }, { people, agents });
}

/**
 * Leaving link sharing (`leavesPublic`): the people it can't count (visitors who aren't signed in,
 * people outside the server) lose it too, so it is said whenever it is so, with any count or none
 * (the contract's `leavesPublic`; Kirby, #13758: who sees it outside the server is a consequence).
 */
function leavesPublicText(formatMessage: FormatMessage, change: ArtifactWebHomeChange, server: ArtifactServerName): string | null {
  return change.leavesPublic ? formatMessage({ id: "artifacts.narrow.leavesPublic" }, server) : null;
}

/** Whether the preview draws anything: a refusal, or a count, a link-sharing line, a change or an error. */
function noticeShown(narrowing: Narrowing | null, formatMessage: FormatMessage): boolean {
  if (!narrowing || narrowing.status === "loading") return false;
  if (narrowing.status === "refused") return true;
  return narrowing.changed || narrowing.error !== null || narrowing.change.leavesPublic || lossText(formatMessage, narrowing.change) !== null;
}

/** What the one live region says for a state: screen readers hear the count once it is in, and each change. */
function announcement(formatMessage: FormatMessage, narrowing: Narrowing | null, server: ArtifactServerName): string {
  if (!narrowing) return "";
  if (narrowing.status === "loading") return formatMessage({ id: "artifacts.narrow.loading" });
  if (narrowing.status === "refused") return narrowing.message;
  return [
    narrowing.changed ? formatMessage({ id: "artifacts.narrow.changed" }) : null,
    lossText(formatMessage, narrowing.change),
    leavesPublicText(formatMessage, narrowing.change, server),
    narrowing.error,
  ].filter(Boolean).join(" ");
}

/**
 * The dialog's one live region, mounted for as long as the dialog is: the
 * banners below are drawn already filled (not live), and this says what
 * they say, so the count is announced when it arrives, not lost to a swap.
 */
function NarrowingAnnouncer({ narrowing }: { narrowing: Narrowing | null }) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="artifact-narrow-live">
      {announcement(formatMessage, narrowing, server)}
    </p>
  );
}

/**
 * The preview as the dialog shows it: refused (and why), or who loses it and, leaving link sharing, that
 * visitors and people outside the server lose it too, even with nobody counted. Nothing while it checks
 * (the confirm button waits, NarrowConfirmation), nor when nobody would lose it and it isn't public (#250).
 */
function NarrowingNotice({ narrowing, moving, onRetry }: {
  narrowing: Narrowing;
  moving: boolean;
  onRetry: () => void;
}) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  // role="none": the banners are not live regions; NarrowingAnnouncer speaks for them.
  if (narrowing.status === "loading") return null;
  if (narrowing.status === "refused") {
    return (
      <Banner status="warning" size="sm" role="none" data-testid="artifact-narrow-refused">
        <TriangleAlert />
        <BannerDescription>{narrowing.message}</BannerDescription>
        {narrowing.retry ? (
          <BannerAction>
            <Button type="button" variant="outline" size="md" onClick={onRetry} disabled={moving} data-testid="artifact-narrow-retry">
              {formatMessage({ id: "artifacts.share.tryAgain" })}
            </Button>
          </BannerAction>
        ) : null}
      </Banner>
    );
  }
  const { change, changed, error } = narrowing;
  const loss = lossText(formatMessage, change);
  const leaves = leavesPublicText(formatMessage, change, server);
  return (
    <>
      {changed ? (
        <Banner status="warning" size="sm" role="none" data-testid="artifact-narrow-changed">
          <TriangleAlert />
          <BannerDescription>{formatMessage({ id: "artifacts.narrow.changed" })}</BannerDescription>
        </Banner>
      ) : null}
      {loss || leaves ? (
        <Banner status="warning" size="sm" role="none" data-testid="artifact-narrow-preview">
          <TriangleAlert />
          {loss ? <BannerTitle data-testid="artifact-narrow-loss">{loss}</BannerTitle> : null}
          {leaves ? <BannerDescription data-testid="artifact-narrow-leaves-public">{leaves}</BannerDescription> : null}
        </Banner>
      ) : null}
      {error ? (
        <Banner status="warning" size="sm" role="none" data-testid="artifact-narrow-error">
          <TriangleAlert />
          <BannerDescription>{error}</BannerDescription>
        </Banner>
      ) : null}
    </>
  );
}

const SERVER_TARGET: ArtifactHomeChangeTarget = { to: "server" };

interface NarrowDialogProps extends NarrowingCallbacks {
  data: ArtifactViewerData;
}

/**
 * Moving the Artifact to a smaller home (`capabilities.narrowHome`), the
 * chip's and the ⋯ menu's: `to` says which confirmation is open (null:
 * none). One root stays mounted so closing returns focus (`finalFocus`: the
 * chip).
 */
export function ArtifactNarrowHomeDialogs({ to, finalFocus, onClose, onUnpublish, onWidenPublic, embed = false, ...props }: NarrowDialogProps & {
  /**
   * Which confirmation is open: a smaller home (`server`, `conversation`, previewed), link sharing
   * turned off without a preview (`unpublish`, no `narrowHome`), or link sharing turned on (`public`).
   */
  to: ArtifactHomeConfirmation | null;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Link sharing off through its own route; settles once answered (a refusal says why itself). */
  onUnpublish: () => Promise<void>;
  /** Widen to anyone with the link; settles once answered (a refusal says why itself). */
  onWidenPublic: () => Promise<void>;
  /** The `public` confirmation is ⋯'s Copy embed code's (#proj-workspace:#260): its body adds what anyone with the link gets and that the code is copied. */
  embed?: boolean;
}) {
  const movingRef = useRef(false);
  // confirm_dialog_closed (#proj-analytics:#17): pressing the confirm counts once per opening,
  // closing without it (Esc, the scrim, Cancel) is a cancel.
  const confirmedRef = useRef(false);
  useEffect(() => { confirmedRef.current = false; }, [to]);
  const onConfirmStart = useCallback(() => {
    if (to === null || confirmedRef.current) return; // `to` is set while a confirmation is open
    confirmedRef.current = true;
    trackArtifactConfirmDialogClosed(HOME_CONFIRM_DIALOG[to], "confirmed");
  }, [to]);
  // Esc, the scrim and Cancel close it, never while a move is in flight.
  const handleOpenChange = useCallback((open: boolean) => {
    if (open || movingRef.current) return;
    if (to !== null && !confirmedRef.current) trackArtifactConfirmDialogClosed(HOME_CONFIRM_DIALOG[to], "cancelled");
    onClose();
  }, [onClose, to]);
  return (
    <AlertDialog open={to !== null} onOpenChange={handleOpenChange}>
      {to === "server" ? <NarrowToServer {...props} finalFocus={finalFocus} movingRef={movingRef} onConfirmStart={onConfirmStart} /> : null}
      {to === "conversation" ? <NarrowToOriginal {...props} finalFocus={finalFocus} movingRef={movingRef} onConfirmStart={onConfirmStart} /> : null}
      {to === "unpublish" ? <UnpublishConfirmation finalFocus={finalFocus} movingRef={movingRef} onConfirm={onUnpublish} onClose={onClose} onConfirmStart={onConfirmStart} /> : null}
      {to === "public" ? <WidenPublicConfirmation finalFocus={finalFocus} movingRef={movingRef} onConfirm={onWidenPublic} onClose={onClose} onConfirmStart={onConfirmStart} embed={embed} /> : null}
    </AlertDialog>
  );
}

/** The home-change confirmations the chip and the ⋯ menu open. */
export type ArtifactHomeConfirmation = "server" | "conversation" | "unpublish" | "public";

const HOME_CONFIRM_DIALOG: Record<ArtifactHomeConfirmation, ArtifactConfirmDialog> = {
  server: "artifact_move_to_server",
  conversation: "artifact_move_to_conversation",
  unpublish: "artifact_unpublish",
  public: "artifact_make_public",
};

interface ActConfirmationProps {
  finalFocus: RefObject<HTMLElement | null>;
  movingRef: MovingRef;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** The person pressed the confirm (analytics). */
  onConfirmStart: () => void;
}

/**
 * Public → the whole server for a reader the server gives no `narrowHome` (so no preview to
 * count with): the same confirmation as the previewed one (NarrowToServer), its title and its
 * button (Raft DS › Feedback, "Confirming": narrowing and unpublishing share one confirmation,
 * whichever route starts it), and what changes for those it can't count, in the orange banner:
 * visitors and people outside the server can't open the link any more (Kirby, #13758).
 */
function UnpublishConfirmation(props: ActConfirmationProps) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  return (
    <ActConfirmation
      {...props}
      testId="artifact-unpublish-dialog"
      title={formatMessage({ id: "artifacts.narrow.serverTitle" })}
      body={null}
      notice={formatMessage({ id: "artifacts.narrow.leavesPublic" }, server)}
      confirmLabel={formatMessage({ id: "artifacts.narrow.serverConfirm" })}
      variant="warning"
    />
  );
}

/**
 * Anyone with the link: shown to a wider audience than the server, so it asks first and says who
 * will see it (Raft DS › Feedback, "Confirming"; Q6). Widening within the server applies at once.
 * Opened by ⋯'s Copy embed code (`embed`), the same confirmation, its body saying a little more: anyone
 * with the link can view it and search engines don't list it (the public page and the embed are
 * noindex), the same warning that seen is seen, and that the code is copied once it is on.
 */
function WidenPublicConfirmation({ embed, ...props }: ActConfirmationProps & { embed: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <ActConfirmation
      {...props}
      testId="artifact-widen-public-dialog"
      title={formatMessage({ id: "artifacts.widen.publicTitle" })}
      body={formatMessage({ id: embed ? "artifacts.embed.publicBody" : "artifacts.share.widenPublicBody" })}
      notice={null}
      confirmLabel={formatMessage({ id: "artifacts.widen.publicConfirm" })}
      variant="accent"
    />
  );
}

/** A home change with nothing to preview: what it does, then the route; closing is off while it runs. */
function ActConfirmation({ finalFocus, movingRef, onConfirm, onClose, onConfirmStart, testId, title, body, notice, confirmLabel, variant }: ActConfirmationProps & {
  testId: string;
  title: string;
  /** What it does beyond the title; null: nothing. */
  body: string | null;
  /** What changes for others, in the orange banner; null: none. */
  notice: string | null;
  confirmLabel: string;
  variant: "warning" | "accent";
}) {
  const { formatMessage } = useIntl();
  const [moving, setMoving] = useState(false);
  const confirm = useCallback(() => {
    if (movingRef.current) return;
    onConfirmStart();
    movingRef.current = true;
    setMoving(true);
    void onConfirm().finally(() => {
      movingRef.current = false;
      setMoving(false);
      onClose();
    });
  }, [movingRef, onConfirm, onConfirmStart, onClose]);
  return (
    <AlertDialogContent finalFocus={finalFocus} data-testid={testId}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
      </AlertDialogHeader>
      {body || notice ? (
        <AlertDialogBody className="grid gap-3">
          {body ? <AlertDialogDescription>{body}</AlertDialogDescription> : null}
          {notice ? (
            <Banner status="warning" size="sm" role="none">
              <TriangleAlert />
              <BannerDescription>{notice}</BannerDescription>
            </Banner>
          ) : null}
        </AlertDialogBody>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel size="lg" disabled={moving} data-testid="artifact-home-cancel">
          {formatMessage({ id: "artifacts.share.cancel" })}
        </AlertDialogCancel>
        <AlertDialogAction variant={variant} size="lg" loading={moving} disabled={moving} onClick={confirm} data-testid="artifact-home-confirm">
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

interface NarrowContentProps extends NarrowDialogProps {
  finalFocus: RefObject<HTMLElement | null>;
  movingRef: MovingRef;
  /** The person pressed the confirm (analytics). */
  onConfirmStart: () => void;
}

/**
 * Anyone with the link → the whole server (link sharing off): a confirmation
 * with the preview's count, then the home route with that count.
 */
function NarrowToServer(props: NarrowContentProps) {
  const { formatMessage } = useIntl();
  return (
    <NarrowConfirmation
      {...props}
      target={SERVER_TARGET}
      title={formatMessage({ id: "artifacts.narrow.serverTitle" })}
      confirmLabel={formatMessage({ id: "artifacts.narrow.serverConfirm" })}
    />
  );
}

/**
 * The whole server or public → its original conversation (#75: narrowing
 * undoes a share that went too wide, so the one conversation it can go back
 * to is the one it was published, saved or imported in, the viewer's
 * `originalHome`; no picker). Named in the title as the reader's own channel
 * list names it ("Move to #growth?"), else (not in their list) without a
 * name, never one from anywhere else. A refusal that it isn't the original any more (NOT_ORIGINAL_HOME)
 * reads the viewer again: the chip then offers what the server says now.
 */
function NarrowToOriginal(props: NarrowContentProps) {
  const { formatMessage } = useIntl();
  const conversationId = props.data.originalHome?.conversationId ?? null;
  const conversation = artifactShareHost().useConversation(conversationId);
  const target = useMemo<ArtifactHomeChangeTarget | null>(
    () => (conversationId ? { to: "conversation", conversationId } : null),
    [conversationId],
  );
  const name = conversation ? conversationLabel(conversation) : null;
  return (
    <NarrowConfirmation
      {...props}
      target={target}
      title={name === null ? formatMessage({ id: "artifacts.narrow.conversationTitle" }) : formatMessage({ id: "artifacts.narrow.conversationTitleNamed" }, { name })}
      confirmLabel={formatMessage({ id: "artifacts.narrow.conversationConfirm" })}
    />
  );
}

/**
 * A narrowing's confirmation (DS AlertDialog, orange: people lose it, and
 * it can be widened again): what it does (the title), the preview's count
 * for `target` (null: there is nothing to narrow to any more, said so and
 * nothing is asked), then the home route with that count. While the count
 * is checked, the confirm button waits (loading, #250: no banner saying
 * so). While it moves, Try again and closing are off.
 */
function NarrowConfirmation({ data, onMoved, onStale, finalFocus, movingRef, onConfirmStart, target, title, confirmLabel }: NarrowContentProps & {
  target: ArtifactHomeChangeTarget | null;
  title: string;
  confirmLabel: string;
}) {
  const { formatMessage } = useIntl();
  const asked = useNarrowing(data.card.id, target, { onMoved, onStale, onConfirmStart }, movingRef);
  const { moving, retry, confirm } = asked;
  // Nothing to narrow to (read again after a refusal, the server offers none now): said as a stale choice.
  const noTarget = useMemo<Narrowing>(() => ({ status: "refused", message: formatMessage({ id: "artifacts.home.notNarrower" }), retry: false }), [formatMessage]);
  const narrowing: Narrowing | null = target ? asked.narrowing : noTarget;
  const checking = narrowing?.status === "loading";
  return (
    <AlertDialogContent finalFocus={finalFocus} data-testid="artifact-narrow-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
      </AlertDialogHeader>
      {/* The live region stays mounted throughout; the body only while the preview draws something (no empty padding). */}
      <NarrowingAnnouncer narrowing={narrowing} />
      {narrowing && noticeShown(narrowing, formatMessage) ? (
        <AlertDialogBody className="grid gap-3">
          <NarrowingNotice narrowing={narrowing} moving={moving} onRetry={retry} />
        </AlertDialogBody>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel size="lg" disabled={moving} data-testid="artifact-narrow-cancel">
          {formatMessage({ id: "artifacts.share.cancel" })}
        </AlertDialogCancel>
        <AlertDialogAction
          variant="warning"
          size="lg"
          loading={moving || checking}
          loadingLabel={checking ? formatMessage({ id: "artifacts.narrow.loading" }) : undefined}
          disabled={moving || (!checking && narrowing?.status !== "ready")}
          onClick={confirm}
          data-testid="artifact-narrow-confirm"
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
