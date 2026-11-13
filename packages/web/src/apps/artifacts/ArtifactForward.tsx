import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  RadioGroup,
  RadioGroupItem,
} from "@botiverse/raft-ui";
import { ARTIFACT_SHARE_NOTE_MAX_CHARS } from "@botiverse/raft-shared";
import type { ArtifactHome, ArtifactViewerData, ArtifactWebShareAudience, ArtifactWebWidenRefusal, ChannelId, MessageId } from "@botiverse/raft-shared";

import { eventServer, trackArtifactShared } from "./artifactAnalytics";
import { artifactErrorCode, artifactErrorDetails } from "./artifactApi";
import { artifactSource } from "./artifactSource";
import { artifactShareNoteKey } from "./artifactShareHost";
import type { ArtifactForwardDialogProps, ArtifactForwardTarget } from "./artifactShareHost";
import ArtifactMessageCard from "./ArtifactMessageCard";
import { useArtifactServerName } from "./artifactServerName";
import type { ArtifactServerName } from "./artifactServerName";

type Choice = "send" | "server" | "public";

const LOADING = { status: "loading" } as const;

type AudienceState =
  | { status: "loading" }
  | { status: "ok"; audience: ArtifactWebShareAudience }
  | { status: "failed" }
  /** TARGET_NOT_FOUND: the person can't post there (any more). */
  | { status: "gone" };

/**
 * Who can't see the Artifact in a conversation, counts only, never names
 * (F21, Tenny). Asked only for the conversations the person chooses, never
 * for the rows as they show (xxchan: the list doesn't count). Kept while the
 * dialog is open: once per conversation, again only after a failure (Try
 * again, or choosing it again) or once its home moved. Each conversation has
 * its own state, so a slow or failed one holds up nothing else (Tenny,
 * #proj-workspace 695de3a7). `ask` answers with the state it settles in.
 */
function useAudiences(artifact: ArtifactViewerData["card"]["id"]) {
  const [audiences, setAudiences] = useState<Record<string, AudienceState>>({});
  /** Asked and not failed: the cache, as the answer to come. */
  const asked = useRef(new Map<string, Promise<AudienceState>>());
  const set = useCallback((conversationId: string, state: AudienceState) => {
    setAudiences((current) => ({ ...current, [conversationId]: state }));
    return state;
  }, []);
  const ask = useCallback((conversationId: ChannelId, again = false): Promise<AudienceState> => {
    const cached = asked.current.get(conversationId);
    if (cached && !again) return cached;
    set(conversationId, LOADING);
    const answer = artifactSource().shareAudience(artifact, { conversationId }).then(
      (audience: ArtifactWebShareAudience) => set(conversationId, { status: "ok", audience }),
      (error: unknown) => {
        const gone = artifactErrorCode(error) === "TARGET_NOT_FOUND";
        // A failed answer isn't kept: asking again (Try again, the send) asks the server.
        if (!gone) asked.current.delete(conversationId);
        return set(conversationId, { status: gone ? "gone" : "failed" });
      },
    );
    asked.current.set(conversationId, answer);
    return answer;
  }, [artifact, set]);
  const markGone = useCallback((conversationId: string) => {
    asked.current.set(conversationId, Promise.resolve({ status: "gone" }));
    set(conversationId, { status: "gone" });
  }, [set]);
  return { audiences, ask, markGone };
}

/** Why a send to one conversation didn't happen (the share route's refusal; nothing was posted there). */
type SendError = "failed" | "forbidden" | "nameTaken" | "notVisible";

const SEND_ERROR_MESSAGES = {
  failed: "artifacts.share.failed",
  forbidden: "artifacts.share.forbidden",
  nameTaken: "artifacts.share.nameTaken",
  notVisible: "artifacts.share.notVisible",
} as const satisfies Record<SendError, string>;

/** Larger homes first: a send that moves it goes before those that don't, so they reach the people it now reaches. */
const WIDEN_ORDER = { public: 0, server: 1, none: 2 } as const;

/** The default choice where some can't see it: the whole server when it is offered (W15 3.4), never public. */
function defaultChoice(audience: ArtifactWebShareAudience | null): Choice {
  return audience && audience.cannotSee > 0 && audience.widenTo.includes("server") ? "server" : "send";
}

/** The choice kept for a conversation while its current answer still offers it (after a refusal the server may offer less). */
function chosenFor(choice: Choice | undefined, audience: ArtifactWebShareAudience | null): Choice {
  if (choice === "send" || (choice && audience?.widenTo.includes(choice))) return choice;
  return defaultChoice(audience);
}

/** What an Artifact is in core's Forward dialog (#proj-workspace:#99): its preview, notices and delivery. */
export interface ArtifactForward {
  title: string;
  sendLabel: string;
  preview: ReactNode;
  notices: ReactNode;
  blockedReason: string | null;
  draftKey: string;
  noteMaxLength: number;
  /**
   * Sends to each; resolves with those it posted in, and those held back for
   * the person to choose how (with the line saying so). The rest say why, in
   * their notice.
   */
  send: (
    targets: ReadonlyArray<ArtifactForwardTarget & { conversationId: ChannelId }>,
    note: string,
  ) => Promise<{
    sent: Array<{ conversationId: ChannelId; messageId: MessageId }>;
    held: { channelIds: ChannelId[]; message: string } | null;
  }>;
}

/**
 * "Send to conversation" (F21, F29, #proj-workspace:#99): an Artifact as
 * what core's Forward dialog forwards, so it is chosen, noted and sent as
 * messages are, to one conversation or several. For each chosen
 * conversation, who there can't see it (asked for that one only).
 *
 * When everyone there can see it, it just sends (F21a). When some can't:
 * that conversation's notice names it, with the counts (never names), the
 * larger homes this person may move it to as part of the send (`widenTo`,
 * from the server: D13 decides who may, and only homes that reach some of
 * them are offered), and "Send anyway", where those people get a plain link
 * (F21). Each conversation has its own choice: declining the move for one
 * still sends to the others. What it offers and shows off comes from the
 * server's `widenTo` and `widenRefused`, the same answers the visibility chip
 * reads, so the two never disagree. A send that moves it moves the home
 * first (its answer's `home`; null on a retry of an attempt that already
 * posted); such sends go first. A conversation only known once the send
 * starts (a new DM, a channel joined for it) is asked then, and held back
 * if some there can't see it, for the person to choose. Moving it into
 * another conversation is never part of a send: that is a narrowing, the
 * visibility chip's (ArtifactNarrowHome).
 */
export function useArtifactForward(
  { data, onShared, onStale }: Omit<ArtifactForwardDialogProps, "onClose">,
  targets: readonly ArtifactForwardTarget[],
): ArtifactForward {
  const { formatMessage } = useIntl();
  const { card } = data;
  // Whether the server lets this viewer move it at all (the chip's own rule): for why no larger home is offered.
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [errors, setErrors] = useState<Record<string, SendError>>({});
  const [noteLimit, setNoteLimit] = useState<number | null>(null);
  const { audiences, ask, markGone } = useAudiences(card.id);
  /** What the person saw when they pressed Send (a send reads them after awaits). */
  const seen = useRef({ audiences, choices });
  useEffect(() => {
    seen.current = { audiences, choices };
  }, [audiences, choices]);
  /**
   * Each conversation's send attempt `clientKey`, kept while what it sends
   * is unchanged: a retry (after a failure that may still have posted, e.g.
   * a dropped answer) is the same attempt, and the server posts it once.
   * Another note or choice is a new attempt with a new key.
   */
  const attempts = useRef(new Map<string, { input: string; clientKey: string }>());

  // Chosen: only then is the server asked (xxchan: one count, for each one chosen).
  useEffect(() => {
    for (const target of targets) if (target.conversationId) void ask(target.conversationId);
  }, [targets, ask]);

  const choose = useCallback((conversationId: string, value: unknown) => {
    if (value !== "send" && value !== "server" && value !== "public") return;
    setChoices((current) => ({ ...current, [conversationId]: value }));
  }, []);

  const known = targets.filter((target): target is ArtifactForwardTarget & { conversationId: ChannelId } => target.conversationId !== null);
  const stateOf = (conversationId: string): AudienceState => audiences[conversationId] ?? LOADING;
  // A failed count doesn't block sending: the server checks again on send (Tenny).
  const loading = known.some((target) => stateOf(target.conversationId).status === "loading");
  const gone = known.find((target) => stateOf(target.conversationId).status === "gone");
  const blockedReason = gone
    ? formatMessage({ id: "artifacts.share.targetGone" }, { target: gone.label })
    : loading ? formatMessage({ id: "artifacts.share.audienceLoading" }) : null;

  const send = useCallback(async (
    chosen: ReadonlyArray<ArtifactForwardTarget & { conversationId: ChannelId }>,
    note: string,
  ) => {
    setErrors({});
    setNoteLimit(null);
    const trimmed = note.trim() ? note.trim() : null;
    const planned: Array<{ target: ArtifactForwardTarget & { conversationId: ChannelId }; widenTo: "server" | "public" | null }> = [];
    const held: Array<ArtifactForwardTarget & { conversationId: ChannelId }> = [];
    for (const target of chosen) {
      const shown = seen.current.audiences[target.conversationId];
      const state = await ask(target.conversationId);
      if (state.status === "gone") continue;
      const audience = state.status === "ok" ? state.audience : null;
      // Known only now (a new DM, a channel joined for it) and some there can't see it: held back for the person to choose.
      if (audience && audience.cannotSee > 0 && shown?.status !== "ok") {
        held.push(target);
        continue;
      }
      const choice = chosenFor(seen.current.choices[target.conversationId], audience);
      planned.push({ target, widenTo: audience && audience.cannotSee > 0 && choice !== "send" ? choice : null });
    }
    planned.sort((a, b) => WIDEN_ORDER[a.widenTo ?? "none"] - WIDEN_ORDER[b.widenTo ?? "none"]);
    const sent: Array<{ conversationId: ChannelId; messageId: MessageId }> = [];
    const failed: Record<string, SendError> = {};
    let moved: ArtifactHome | null = null;
    let stale = false;
    for (const { target, widenTo } of planned) {
      const input = { conversationId: target.conversationId, threadRootId: null, note: trimmed, widenTo };
      const signature = JSON.stringify(input);
      let attempt = attempts.current.get(target.conversationId);
      if (attempt?.input !== signature) {
        attempt = { input: signature, clientKey: crypto.randomUUID() };
        attempts.current.set(target.conversationId, attempt);
      }
      try {
        const at = eventServer();
        const result = await artifactSource().share(card.id, { ...input, clientKey: attempt.clientKey });
        trackArtifactShared({ target: target.kind, withNote: input.note !== null, widenTo }, at);
        if (result.home) moved = result.home;
        sent.push({ conversationId: target.conversationId, messageId: result.messageId });
      } catch (failure) {
        const code = artifactErrorCode(failure);
        const tooLong = artifactErrorDetails(failure, "FIELD_TOO_LONG");
        if (code === "TARGET_NOT_FOUND") markGone(target.conversationId);
        else if (tooLong && tooLong.field === "note") {
          setNoteLimit(tooLong.limit);
          break;
        } else if (code === "FORBIDDEN" || code === "NAME_TAKEN") {
          // The move was refused (who may widen, or the name in the larger home, changed since the
          // audience was asked), so nothing was posted there: ask again; a choice the new answer no
          // longer offers falls back to what it does (`chosenFor`). A share's move never answers
          // HOME_NOT_WIDER (already that wide is no refusal there).
          failed[target.conversationId] = code === "NAME_TAKEN" ? "nameTaken" : "forbidden";
          void ask(target.conversationId, true);
          if (code === "FORBIDDEN") stale = true;
        } else if (code === "NOT_VISIBLE") {
          // Gone for this person: nothing else can be sent either.
          failed[target.conversationId] = "notVisible";
          stale = true;
          break;
        } else failed[target.conversationId] = "failed";
      }
    }
    setErrors(failed);
    if (moved) {
      // Sending with a larger home moved it: who can see it changed for the rest too.
      onShared(moved);
      for (const target of chosen) if (!sent.some((s) => s.conversationId === target.conversationId)) void ask(target.conversationId, true);
    }
    if (stale) onStale();
    return {
      sent,
      held: held.length > 0
        ? {
          channelIds: held.map((target) => target.conversationId),
          message: formatMessage({ id: "artifacts.share.heldForChoice" }, { targets: held.map((target) => target.label).join(", ") }),
        }
        : null,
    };
  }, [ask, markGone, card.id, onShared, onStale, formatMessage]);

  const reference = useMemo(() => ({ status: "ok" as const, card }), [card]);
  // What is about to be sent, not a way in: nothing on it opens (#proj-workspace:#104).
  const preview = <ArtifactMessageCard reference={reference} preview />;

  const notices = (
    // Each conversation's notices in a box of its own that takes no room while it says nothing.
    <div className="contents" data-testid="artifact-share-notices">
      {noteLimit !== null ? (
        <Banner status="warning" size="sm" role="alert" className="mb-3" data-testid="artifact-share-note-error">
          <TriangleAlert />
          <BannerDescription>{formatMessage({ id: "artifacts.share.noteTooLong" }, { limit: noteLimit })}</BannerDescription>
        </Banner>
      ) : null}
      {known.map((target) => (
        <TargetNotices
          key={target.key}
          label={target.label}
          state={stateOf(target.conversationId)}
          error={errors[target.conversationId] ?? null}
          choice={choices[target.conversationId]}
          conversationId={target.conversationId}
          onChoice={choose}
          onRetry={ask}
        />
      ))}
    </div>
  );

  return {
    title: formatMessage({ id: "artifacts.share.title" }),
    sendLabel: formatMessage({ id: "artifacts.share.send" }),
    preview,
    notices,
    blockedReason,
    draftKey: artifactShareNoteKey(card.id),
    noteMaxLength: ARTIFACT_SHARE_NOTE_MAX_CHARS,
    send,
  };
}

/** One chosen conversation's notices: who there can't see it and what to do, and why its send didn't go. */
function TargetNotices({
  label,
  state,
  error,
  choice,
  conversationId,
  onChoice,
  onRetry,
}: {
  label: string;
  state: AudienceState;
  error: SendError | null;
  choice: Choice | undefined;
  conversationId: ChannelId;
  onChoice: (conversationId: string, value: unknown) => void;
  onRetry: (conversationId: ChannelId, again: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const handleChoice = useCallback((value: unknown) => onChoice(conversationId, value), [onChoice, conversationId]);
  const handleRetry = useCallback(() => onRetry(conversationId, true), [onRetry, conversationId]);
  const audience = state.status === "ok" ? state.audience : null;
  return (
    <div className="mb-3 flex flex-col gap-3 empty:hidden" data-testid={`artifact-share-target-${conversationId}`}>
      <AudienceNotice
        label={label}
        state={state}
        chosen={chosenFor(choice, audience)}
        onChoice={handleChoice}
        onRetry={handleRetry}
      />
      {error ? (
        <Banner status="warning" size="sm" role="alert" data-testid="artifact-share-error">
          <TriangleAlert />
          <BannerTitle>{label}</BannerTitle>
          <BannerDescription>{formatMessage({ id: SEND_ERROR_MESSAGES[error] })}</BannerDescription>
        </Banner>
      ) : null}
    </div>
  );
}

/**
 * The larger homes that would let them see it but aren't offered (#77, the
 * server's `widenRefused`, narrowest first), as options that are off, each
 * saying why under it, or it reads as a bug (Kirby): `forbidden`, no
 * permission (a line, not a tooltip: an option that's off takes no focus,
 * and touch has no hover; Kirby, #13758); `name_taken`, another Artifact
 * there has its name, named, until one is renamed.
 * None from a server that doesn't say (`widenRefused` absent).
 */
function refusedHomes(formatMessage: IntlShape["formatMessage"], audience: ArtifactWebShareAudience, server: ArtifactServerName): AudienceOption[] {
  return (audience.widenRefused ?? []).map((refusal) => ({
    value: refusal.to,
    label: homeLabel(formatMessage, refusal.to, server),
    body: refusal.reason === "name_taken"
      ? formatMessage({ id: refusal.to === "server" ? "artifacts.share.serverNameTaken" : "artifacts.share.publicNameTaken" }, { name: refusal.name, ...server })
      : formatMessage({ id: refusal.to === "server" ? "artifacts.share.serverForbidden" : "artifacts.share.publicForbidden" }, server),
    disabled: true,
  }));
}

/** What the notice offers: a choice, or a home the reader can't choose (`disabled`). */
interface AudienceOption {
  value: Choice;
  label: string;
  /** Under the label: what else it does, or why it is off; none for Send anyway (#250). */
  body?: string;
  disabled?: boolean;
}

function homeLabel(formatMessage: IntlShape["formatMessage"], to: ArtifactWebWidenRefusal["to"], server: ArtifactServerName): string {
  return formatMessage({ id: to === "server" ? "artifacts.share.widenServer" : "artifacts.share.widenPublic" }, server);
}

/**
 * Who there can't see it, and what to do (F21): nothing when everyone can
 * (F21a), nor while it is asked (Send waits, its reason says why; #250); else
 * the counts, the larger homes on offer and "Send anyway". Who can see it now
 * is the preview card's chip, not a line here.
 *
 * The title is the one sentence (who can't see it), and there is no
 * description; the choices are a RadioGroup of their own in the banner's body
 * under it (Kirby), named "How to send it" and described by the title.
 */
function AudienceNotice({
  label,
  state,
  chosen,
  onChoice,
  onRetry,
}: {
  /** The conversation, as the dialog names it. */
  label: string;
  state: AudienceState;
  chosen: Choice;
  onChoice: (value: unknown) => void;
  onRetry: () => void;
}) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  const titleId = useId();
  // Nothing while it is asked: a notice appears only if some can't (xxchan, #proj-workspace:#76), and Send waits
  // meanwhile, saying why (`blockedReason`).
  if (state.status === "loading") return null;
  if (state.status === "gone") {
    return (
      <Banner status="warning" size="sm" role="alert" data-testid="artifact-share-target-gone">
        <TriangleAlert />
        <BannerDescription>{formatMessage({ id: "artifacts.share.targetGone" }, { target: label })}</BannerDescription>
      </Banner>
    );
  }
  if (state.status === "failed") {
    return (
      <Banner status="warning" size="sm" role="alert" data-testid="artifact-share-audience-failed">
        <TriangleAlert />
        <BannerDescription>{formatMessage({ id: "artifacts.share.audienceFailed" })}</BannerDescription>
        <BannerAction>
          <Button type="button" variant="outline" size="md" onClick={onRetry} data-testid="artifact-share-audience-retry">
            {formatMessage({ id: "artifacts.share.tryAgain" })}
          </Button>
        </BannerAction>
      </Banner>
    );
  }
  const { audience } = state;
  if (audience.cannotSee === 0) return null;
  const options: AudienceOption[] = audience.widenTo.map((to) => ({
    value: to,
    label: homeLabel(formatMessage, to, server),
    body: [
      formatMessage({ id: to === "server" ? "artifacts.share.widenServerBody" : "artifacts.share.widenPublicBody" }),
      // D4: a server home never reaches guests.
      to === "server" && audience.guestsCannotSee > 0 ? formatMessage({ id: "artifacts.share.guestsStillCannot" }, { count: audience.guestsCannotSee }) : null,
    ].filter(Boolean).join(" "),
  }));
  options.push({ value: "send", label: formatMessage({ id: "artifacts.share.sendAnyway" }) });
  // The default choice first (stdrc, 2026-11-05).
  const preferred = defaultChoice(audience);
  options.sort((a, b) => Number(b.value === preferred) - Number(a.value === preferred));
  options.push(...refusedHomes(formatMessage, audience, server));
  return (
    <Banner status="warning" size="sm" data-testid="artifact-share-audience">
      <TriangleAlert />
      <BannerTitle id={titleId} data-testid="artifact-share-audience-title">
        {formatMessage(
          { id: audience.capped
            ? audience.guestsCannotSee > 0 ? "artifacts.share.cannotSeeCappedWithGuests" : "artifacts.share.cannotSeeCapped"
            : audience.guestsCannotSee > 0 ? "artifacts.share.cannotSeeWithGuests" : "artifacts.share.cannotSee" },
          { count: audience.cannotSee, guests: audience.guestsCannotSee, target: label },
        )}
      </BannerTitle>
      {/* In the banner's text column (Banner's own --banner-text-col), on the row under the title. */}
      <RadioGroup
        value={chosen}
        onValueChange={onChoice}
        aria-label={formatMessage({ id: "artifacts.share.optionsLabel" })}
        aria-describedby={titleId}
        className="col-start-(--banner-text-col,1) mt-1 gap-0"
        data-testid="artifact-share-options"
      >
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-start gap-2 py-1.5">
            <RadioGroupItem value={option.value} disabled={option.disabled} className="shrink-0" data-testid={`artifact-share-option-${option.value}`} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={`text-subhead font-semibold ${option.disabled ? "text-foreground-disabled" : "text-foreground"}`} data-testid="artifact-share-option-label">{option.label}</span>
              {option.body ? (
                <span className={`text-footnote ${option.disabled ? "text-foreground-hint" : "text-foreground-muted"}`} data-testid={option.disabled ? "artifact-share-widen-refused" : undefined}>{option.body}</span>
              ) : null}
            </span>
          </label>
        ))}
      </RadioGroup>
    </Banner>
  );
}
