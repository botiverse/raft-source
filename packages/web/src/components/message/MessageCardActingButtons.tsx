import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useShallow } from "zustand/react/shallow";
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner, Text, TextLink, Tooltip, TooltipContent, TooltipTrigger, messageCard, toast } from "@botiverse/raft-ui";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { MessageCard, MessageCardActingButton } from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import { linkPreviewAppKey, linkPreviewViewerKey, useLinkPreviewConsentStore } from "../../store/linkPreviewConsentStore";
import type { LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import { useServerStore } from "../../store/serverStore";
import { LinkCardConfirmDialog } from "./LinkCardActions";
import { linkCardViewKey, pressLinkCardButton, useLinkCardActionStore } from "./linkCardExecute";
import type { LinkCardButton } from "./linkCardExecute";
import { LinkPreviewConsentPrompt } from "./LinkPreviewConsentPrompt";
import type { LinkPreviewPromptState } from "./LinkPreviewConsentPrompt";
import { messageCardActionResult, messageCardActionUrls, messageCardAnswerIsCurrent, messageCardButtonState, messageCardPressResumes, messageCardViewsBusy } from "./messageCardActions";
import type { MessageCardActing, MessageCardActionsRead, MessageCardButtonState } from "./messageCardActions";

// A card message's button row when the card has acting buttons (RFC 086 step
// 1; DS Cards in messages › Buttons). Which state each button draws is
// messageCardActions.ts; a press runs the link card flows (linkCardExecute.tsx)
// with this message and the button's fallback page as the operation's
// identity. docs/development/app-link-previews.md, "Card messages with acting buttons".

type CardButton = Extract<MessageCard["elements"][string], { type: "Button" }>["props"];

/** The waits before the card's answer is read again when it brought nothing usable; then it stays as it is until the row comes back. */
const RETRY_AFTER_MS = [2000, 8000, 30_000];

/**
 * The card's buttons in the card's own row: the acting ones as raft-ui
 * Buttons that run (or say why they can't), the others as the links they are
 * (`link`, MessageCardBody's). One reason is one line beside the buttons
 * (messageCard's actionGroup, so the line wraps first), visible without
 * hover, and each disabled button's tooltip and description: "Waiting for
 * {name}", the App turned off (with Allow), or Raft's neutral "not available
 * right now". While something runs, that line is the link card's status line
 * ("Working…"). One open operation per card: every acting button waits
 * while any of them is busy. Without a read (`read` null: a read-only view of
 * the message) the buttons are unavailable and nothing is read.
 */
export function MessageCardActingButtons({ acting, buttons, read, link }: {
  acting: MessageCardActing;
  buttons: ReadonlyArray<[string, CardButton]>;
  read: MessageCardActionsRead | null;
  link: (id: string, button: CardButton, index: number) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const owner = useId();
  const statusId = useId();
  const row = useRef<HTMLDivElement>(null);
  // Where focus goes back to when Raft's dialog closes: the button that opened it.
  const pressed = useRef<HTMLElement | null>(null);
  const viewerKey = linkPreviewViewerKey(useAuthStore((s) => s.user?.id), useServerStore((s) => s.current?.id));
  const answer = read?.answer ?? null;
  const appId = answer?.app?.id;
  const consentStatus = useLinkPreviewConsentStore((s) => (appId ? s.status[linkPreviewAppKey(viewerKey, appId)] : undefined));
  // The Server said card actions are off (a 404 from prepare or execute): no button runs.
  const actionsOff = useLinkCardActionStore((s) => !!s.unavailable[viewerKey]);

  // Nothing usable came back (no answer, or one for another revision): read again, quietly, a few times.
  const [tried, setTried] = useState({ revision: acting.revision, n: 0 });
  const tries = tried.revision === acting.revision ? tried.n : 0;
  const unanswered = !!read && !read.loading && !messageCardAnswerIsCurrent(acting, answer);
  const retryAfter = unanswered ? RETRY_AFTER_MS[tries] : undefined;
  const retry = read?.retry;
  useEffect(() => {
    if (retryAfter === undefined || !retry) return;
    const timer = setClockTimeout(() => {
      setTried({ revision: acting.revision, n: tries + 1 });
      retry();
    }, retryAfter);
    return () => clearClockTimeout(timer);
  }, [retryAfter, retry, tries, acting.revision]);

  const byId = useMemo(() => new Map(acting.buttons.map((button) => [button.elementId, button])), [acting]);
  const stateOf = (elementId: string): MessageCardButtonState => (actionsOff || consentStatus === "unavailable"
    ? { kind: "unavailable" }
    : messageCardButtonState({
      acting, elementId, answer, loading: !!read?.loading, retrying: retryAfter !== undefined,
      declinedHere: consentStatus === "declined" || consentStatus === "declining",
    }));

  // The link card machinery's view of each fallback page, and its state: busy, the open operation, Raft's dialog.
  const urls = useMemo(() => messageCardActionUrls(acting), [acting]);
  const view = read?.view;
  const readAt = read?.readAt ?? 0;
  const results = useMemo(
    () => new Map(urls.flatMap((url) => {
      const result = view ? messageCardActionResult(url, acting, { answer, readAt }, view) : null;
      return result ? [[url, result] as const] : [];
    })),
    [urls, view, acting, answer, readAt],
  );
  const viewStates = useLinkCardActionStore(useShallow((s) => urls.map((url) => (view ? s.views[linkCardViewKey(view, url)] : undefined))));
  const { holding, blocked, pending } = messageCardViewsBusy(viewStates);
  const workingOn = (button: MessageCardActingButton) => {
    const state = viewStates[urls.indexOf(button.url)];
    return (state?.busy === "reading" || state?.busy === "preparing") && state.actionId === button.action.action_id;
  };

  // The first-view prompt a press opened, and the press it stands before (messageCardPressResumes).
  const [asking, setAsking] = useState<string | null>(null);
  const resume = useRef<{ elementId: string; revision: number; allowedAt: number } | null>(null);
  const press = useCallback((button: MessageCardActingButton) => {
    const result = results.get(button.url);
    const node = result?.cardV2?.elements[button.elementId];
    pressed.current = row.current?.querySelector<HTMLElement>(`[data-message-card-action-element="${CSS.escape(button.elementId)}"]`) ?? null;
    // An earlier operation of this view Raft still holds open (VIEW_PENDING) is no error here: the row shows it pending.
    if (result && node?.type === "Button") void pressLinkCardButton({ result, button: node.props as LinkCardButton, owner, format: formatMessage, quietViewPending: true });
  }, [results, owner, formatMessage]);
  const allow = useCallback((app: LinkPreviewApp) => {
    const elementId = asking;
    void useLinkPreviewConsentStore.getState().allow(viewerKey, app).then((answered) => {
      // Failed: the prompt stays, its Allow now Retry. Otherwise it closes; allowed, the card is read again (useAppLinkPreviews).
      if (answered === "failed") return;
      setAsking(null);
      if (answered === "allowed" && elementId) resume.current = { elementId, revision: acting.revision, allowedAt: currentTimeMs() };
    });
  }, [asking, viewerKey, acting.revision]);
  // "Not now" records nothing: the prompt closes, consent stays needed, and the next press asks again (AppFather).
  const notNow = useCallback(() => setAsking(null), []);
  const allowAgain = useCallback((app: LinkPreviewApp) => {
    void useLinkPreviewConsentStore.getState().allow(viewerKey, app).then((answered) => {
      if (answered === "failed") toast.error(formatMessage({ id: "settings.linkPreviews.allowFailed" }, { app: app.name }));
    });
  }, [viewerKey, formatMessage]);

  // Allowed and read again: the press that asked goes on, or the person is told to press again.
  const resuming = resume.current;
  const resumed = resuming ? stateOf(resuming.elementId) : null;
  const resumedKind = resumed?.kind;
  useEffect(() => {
    const waiting = resume.current;
    if (!waiting || !resumedKind || resumedKind === "loading" || resumedKind === "consent") return;
    resume.current = null;
    const button = byId.get(waiting.elementId);
    const target = row.current?.querySelector<HTMLElement>(`[data-message-card-action-element="${CSS.escape(waiting.elementId)}"]`);
    // The prompt's own button is gone: focus goes back to the button it was opened from, unless the person moved on.
    if (target && (!document.activeElement || document.activeElement === document.body)) target.focus();
    if (resumedKind !== "ready" || !button) return;
    const app = results.get(button.url)?.app;
    if (messageCardPressResumes({ button, reviewed: app?.reviewed !== false, allowedAt: waiting.allowedAt, allowedRevision: waiting.revision, revision: acting.revision, now: currentTimeMs() })) press(button);
    else toast.info(formatMessage({ id: "message.messageCard.action.pressAgain" }, { app: app?.name ?? "", label: button.label }));
  }, [resumedKind, byId, results, acting.revision, press, formatMessage]);

  const states = buttons.flatMap(([id]) => (byId.has(id) ? [stateOf(id)] : []));
  const reason = states.find((state) => state.kind === "waiting" || state.kind === "declined" || state.kind === "unavailable");
  const reasonText = !reason ? null
    : reason.kind === "waiting" ? (reason.name ? formatMessage({ id: "message.messageCard.action.waitingFor" }, { name: reason.name }) : formatMessage({ id: "message.messageCard.action.waitingForSomeone" }))
    : reason.kind === "declined" ? formatMessage({ id: "message.messageCard.action.declined" }, { app: reason.app.name })
    : formatMessage({ id: "message.messageCard.action.unavailable" }, { count: states.filter((state) => state.kind === "unavailable").length });
  const status = holding ? "holding" : pending ? "pending" : reason ? reason.kind : null;
  const { actionRow, actionGroup } = messageCard();
  return (
    <div ref={row} className={actionRow({ className: "min-w-0" })} data-message-card-buttons="" data-message-card-actions={status ?? states[0]?.kind} aria-busy={pending || undefined}>
      {status ? (
        <Text.Sans id={statusId} role="status" size="small" variant="muted" className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-message-card-action-status={status}>
          {status === "pending" ? <Spinner size="xs" aria-hidden="true" /> : null}
          <span className="min-w-0 break-words">
            {status === "holding" ? formatMessage({ id: "message.appLink.action.holding" }) : status === "pending" ? formatMessage({ id: "message.appLink.action.working" }) : reasonText}
          </span>
          {status === "declined" && reason?.kind === "declined" ? (
            <DeclinedAllow app={reason.app} busy={consentStatus === "allowing"} onAllow={allowAgain} />
          ) : null}
        </Text.Sans>
      ) : null}
      <div className={actionGroup()} data-message-card-button-group="">
        {buttons.map(([id, button], index) => {
          const stored = byId.get(id);
          if (!stored) return link(id, button, index);
          const state = stateOf(id);
          return (
            <ActingButton
              key={id}
              stored={stored}
              variant={button.variant === "ghost" ? "ghost" : "default"}
              state={state}
              blocked={blocked}
              working={workingOn(stored)}
              reason={state.kind === "waiting" || state.kind === "declined" || state.kind === "unavailable" ? reasonText : null}
              describedBy={status ? statusId : undefined}
              asking={asking === id}
              prompt={promptState(consentStatus)}
              onPress={press}
              onAsk={setAsking}
              onAllow={allow}
              onNotNow={notNow}
            />
          );
        })}
      </div>
      {[...results.values()].map((result) => <LinkCardConfirmDialog key={result.url} result={result} owner={owner} finalFocus={pressed} />)}
    </div>
  );
}

function promptState(status: string | undefined): LinkPreviewPromptState {
  return status === "allowing" || status === "declining" || status === "failed" ? status : "idle";
}

/** "Allow {App}" after the declined reason: the call Settings › Applications makes for a declined App, which lifts the decline (RFC 086 §4.2). */
function DeclinedAllow({ app, busy, onAllow }: { app: LinkPreviewApp; busy: boolean; onAllow: (app: LinkPreviewApp) => void }) {
  const { formatMessage } = useIntl();
  const allow = useCallback(() => onAllow(app), [app, onAllow]);
  return (
    <TextLink onClick={allow} disabled={busy} data-message-card-action-allow={app.id}>
      {formatMessage({ id: "message.messageCard.action.allowApp" }, { app: app.name })}
    </TextLink>
  );
}

/**
 * One acting button. `ready`: runs on press, disabled while the card is busy
 * (described by the status line), its own spinner while it reads or prepares.
 * `consent`: enabled, and a press opens the App's first-view prompt in an
 * item popover on the button (a card never holds a second card), as an App
 * link's chip asks, in the words for a button ("Allow {App}?", Allow and Not
 * now; Not now saves nothing). Any other state: disabled and still focusable, the
 * reason its tooltip and description, as a card button's stored
 * `disabledReason` is drawn.
 */
function ActingButton({ stored, variant, state, blocked, working, reason, describedBy, asking, prompt, onPress, onAsk, onAllow, onNotNow }: {
  stored: MessageCardActingButton;
  variant: "default" | "ghost";
  state: MessageCardButtonState;
  blocked: boolean;
  working: boolean;
  reason: string | null;
  describedBy: string | undefined;
  asking: boolean;
  prompt: LinkPreviewPromptState;
  onPress: (button: MessageCardActingButton) => void;
  onAsk: (elementId: string | null) => void;
  onAllow: (app: LinkPreviewApp) => void;
  onNotNow: () => void;
}) {
  const { formatMessage } = useIntl();
  const press = useCallback(() => onPress(stored), [onPress, stored]);
  const openChange = useCallback((open: boolean) => onAsk(open ? stored.elementId : null), [onAsk, stored.elementId]);
  const marks = { "data-message-card-button": "acting", "data-message-card-action": state.kind, "data-message-card-action-element": stored.elementId } as const;
  const label = <span className="truncate">{stored.label}</span>;
  if (state.kind === "consent") {
    return (
      <Popover open={asking} onOpenChange={openChange}>
        <PopoverTrigger render={<Button size="sm" variant={variant} disabled={blocked} focusableWhenDisabled className="min-w-0" {...marks} />}>
          {label}
        </PopoverTrigger>
        {/* An item popover (raft-ui size="item"), as the question an App link's chip asks. */}
        <PopoverContent size="item" data-message-card-action-prompt="">
          <div className="p-2">
            <LinkPreviewConsentPrompt
              app={state.app}
              state={prompt}
              onAllow={onAllow}
              onDecline={onNotNow}
              onSecondary={onNotNow}
              title={formatMessage({ id: "message.messageCard.action.consent.title" }, { app: state.app.name })}
              body={formatMessage({ id: "message.messageCard.action.consent.body" }, { app: state.app.name })}
              secondaryLabel={formatMessage({ id: "message.messageCard.action.consent.notNow" })}
            />
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  if (state.kind === "ready") {
    return (
      <Button
        size="sm"
        variant={variant}
        disabled={blocked}
        focusableWhenDisabled
        loading={working}
        loadingLabel={formatMessage({ id: "message.appLink.action.working" })}
        aria-describedby={describedBy}
        onClick={press}
        className="min-w-0"
        {...marks}
      >
        {label}
      </Button>
    );
  }
  const disabled = (
    <Button size="sm" variant={variant} disabled focusableWhenDisabled aria-describedby={describedBy} aria-busy={state.kind === "loading" || undefined} className="min-w-0" {...marks}>
      {label}
    </Button>
  );
  if (!reason) return disabled;
  return (
    <Tooltip>
      <TooltipTrigger render={disabled} />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
