// A card message's acting buttons (RFC 086 step 1): what the web draws for
// each, from the stored card (the same for everyone) and this viewer's answer
// to the link card read (`message_card`: handles, `waiting_for`, `consent`),
// and how a press reaches the link card machinery (linkCardExecute.tsx). Pure:
// the drawing is MessageCardActingButtons.tsx, the read useAppLinkPreviews.ts.
// docs/development/app-link-previews.md, "Card messages with acting buttons".

import type { MessageCardActingButton } from "@botiverse/raft-shared";
import { currentTimeMs, messageCardActionHasSecretInput } from "@botiverse/raft-shared";
import type { LinkCardV2 } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import type { LinkCardMessageView, LinkCardViewState } from "./linkCardExecute";
import { messageCardSealTo } from "./linkCardSeal";
import type { LinkCardSealTo } from "./linkCardSeal";
import type { MessageCardRead } from "./linkCardRead";
import type { AppLinkResult } from "./useAppLinkPreviews";

type CardResult = Extract<AppLinkResult, { kind: "card" }>;

/** A stored card's acting buttons at one revision (messageCardRead.ts). */
export type MessageCardActing = { revision: number; buttons: readonly MessageCardActingButton[] };

/**
 * One read's `message_card` as the message keeps it (in memory, per viewer,
 * like a link card's handles): the answer (null: none, or unreadable), when
 * it was read (client clock), the App whose consent stands in the way (its
 * Allow reads the card again), and which of the card's retries asked for it.
 */
export type LoadedMessageCard = { answer: MessageCardRead | null; readAt: number; consent: { kind: "consent"; url: string; app: LinkPreviewApp } | null; attempt: number };

export function loadedMessageCard(answer: MessageCardRead | null, attempt: number): LoadedMessageCard {
  const consent = answer?.consent && answer.app ? { kind: "consent" as const, url: "", app: { id: answer.app.id, name: answer.app.name, icon: answer.app.icon } } : null;
  return { answer, readAt: currentTimeMs(), consent, attempt };
}

/** What the read gives a card's drawing (useAppLinkPreviews). `loading`: no answer yet, or it is being read again. */
export type MessageCardActionsRead = {
  acting: MessageCardActing;
  answer: MessageCardRead | null;
  readAt: number;
  loading: boolean;
  /** The message view the buttons act through, as a link card's do. */
  view: LinkCardMessageView;
  /** Reads the card's answer again (one read per answer, however often it is called). */
  retry: () => void;
};

/** The card's fallback pages, each once: the links of its message view (the operation's URL identity, RFC 086 §4.3). */
export function messageCardActionUrls(acting: MessageCardActing): string[] {
  return [...new Set(acting.buttons.map((button) => button.url))];
}

/**
 * Whether an answer is for the card as stored: its `card_revision` is the
 * stored revision. One for another revision (the App replaced the card
 * between the two) gives no handle and no reason: the card is read again.
 */
export function messageCardAnswerIsCurrent(acting: MessageCardActing, answer: MessageCardRead | null): answer is MessageCardRead {
  return !!answer && answer.card_revision === String(acting.revision);
}

/**
 * What an acting button draws:
 * - `ready`: Raft signed this viewer a handle for it: enabled, and a press runs it;
 * - `consent`: the viewer never answered this App: enabled, and the first
 *   press asks (the App's first-view prompt) before anything is sent;
 * - `waiting`: the card is for someone else: disabled, "Waiting for {name}";
 * - `declined`: the viewer turned this App off: disabled, with the way back;
 * - `loading`: the answer is on its way (the first read, a new revision's,
 *   the read after Allow): disabled, no reason yet;
 * - `unavailable`: no answer for this button (the read failed, an older
 *   Server, the App can't act here now): disabled, Raft's own neutral words,
 *   never the stored "Update Raft…" (this client is current).
 */
export type MessageCardButtonState =
  | { kind: "ready" }
  | { kind: "consent"; app: LinkPreviewApp }
  | { kind: "waiting"; name: string }
  | { kind: "declined"; app: LinkPreviewApp }
  | { kind: "loading" }
  | { kind: "unavailable" };

/**
 * The state of the acting button `elementId`. `declinedHere`: the viewer
 * answered Don't Allow in this session, after the answer was read.
 * `retrying`: an answer for another revision is about to be read again.
 */
export function messageCardButtonState({ acting, elementId, answer, loading, retrying = false, declinedHere = false }: {
  acting: MessageCardActing;
  elementId: string;
  answer: MessageCardRead | null;
  loading: boolean;
  retrying?: boolean;
  declinedHere?: boolean;
}): MessageCardButtonState {
  const pending: MessageCardButtonState = loading ? { kind: "loading" } : { kind: "unavailable" };
  if (!answer) return pending;
  if (!messageCardAnswerIsCurrent(acting, answer)) return retrying ? { kind: "loading" } : pending;
  // Someone else's card says so whatever else holds for this viewer.
  if (answer.waiting_for) return { kind: "waiting", name: answer.waiting_for.name.trim() };
  if (answer.consent) {
    if (!answer.app) return pending;
    const app = { id: answer.app.id, name: answer.app.name, icon: answer.app.icon };
    if (declinedHere) return { kind: "declined", app };
    // Allowed since: the card is being read again.
    if (loading) return { kind: "loading" };
    return answer.consent === "declined" ? { kind: "declined", app } : { kind: "consent", app };
  }
  const button = acting.buttons.find((candidate) => candidate.elementId === elementId);
  const action = button && answer.app
    ? answer.actions.find((candidate) => candidate.element_id === elementId && candidate.action_id === button.action.action_id && candidate.url === button.url)
    : undefined;
  return button && action && messageCardButtonSeals(answer, button, action) ? { kind: "ready" } : pending;
}

/**
 * Whether a button can be pressed as the read answered it: one whose form
 * holds a SecretInput only on a `confirm: "prepare"` button (the one execute
 * that carries sealed values; Raft refuses any other at send) and with
 * everything its values are sealed with (RFC 086 §5.3: the App's key, its
 * client key and the handle's expiry). Otherwise it is unavailable.
 */
function messageCardButtonSeals(answer: MessageCardRead, button: MessageCardActingButton, action: MessageCardRead["actions"][number]): boolean {
  return !messageCardActionHasSecretInput(button.action) || ("confirm" in button.action && !!messageCardSealTo(answer, action));
}

/**
 * What the card's views are doing together (one per fallback page; buttons
 * that share a page share a view). One open operation per card: while any
 * view is busy or has an open operation every acting button waits
 * (`blocked`), and comes back when it ends. `pending`: something was sent
 * and isn't finished. `holding`: an undo window runs.
 */
export function messageCardViewsBusy(states: ReadonlyArray<LinkCardViewState | undefined>): { holding: boolean; blocked: boolean; pending: boolean } {
  return {
    holding: states.some((state) => state?.busy === "holding"),
    blocked: states.some((state) => !!state?.busy || !!state?.operation),
    pending: states.some((state) => !!state?.operation || state?.busy === "executing" || state?.busy === "recovering" || state?.busy === "refreshing"),
  };
}

/** The root of the card a press hands to the link card machinery: no card element can have this id. */
const PRESS_CARD_ROOT = "#";

/**
 * The acting buttons of one fallback page as the link card machinery takes a
 * press (linkCardExecute.tsx: prepare, Raft's dialog, the undo window,
 * execute, the toast, recovery): a card result whose `url` is the fallback
 * page, so the operation's identity is this message and that URL (RFC 086
 * §4.3), with the handle Raft signed for each button, the stored revision as
 * the revision prepare claims, and the App as Raft names it. Null without a
 * handle for any button of that page in an answer for the stored revision.
 */
export function messageCardActionResult(url: string, acting: MessageCardActing, read: Pick<LoadedMessageCard, "answer" | "readAt">, view?: LinkCardMessageView): CardResult | null {
  const { answer } = read;
  if (!messageCardAnswerIsCurrent(acting, answer) || !answer.app) return null;
  const signed = acting.buttons.flatMap((button) => {
    if (button.url !== url) return [];
    const action = answer.actions.find((candidate) => candidate.element_id === button.elementId && candidate.action_id === button.action.action_id && candidate.url === url);
    if (!action || !messageCardButtonSeals(answer, button, action)) return [];
    // A SecretInput button's values are sealed to what this read answered (RFC 086 §5.3), never to anything from the card.
    const sealTo = messageCardActionHasSecretInput(button.action) ? messageCardSealTo(answer, action) : null;
    return [{ button, handle: action.handle, sealTo }];
  });
  const sealsTo: Record<string, LinkCardSealTo> = Object.fromEntries(signed.flatMap(({ button, sealTo }) => (sealTo ? [[button.action.action_id, sealTo]] : [])));
  if (!signed.length) return null;
  const card = {
    root: PRESS_CARD_ROOT,
    elements: {
      [PRESS_CARD_ROOT]: { type: "Stack", props: { direction: "row", wrap: true }, children: signed.map(({ button }) => button.elementId) },
      ...Object.fromEntries(signed.map(({ button }) => [button.elementId, { type: "Button", props: { label: button.label, variant: "default", action: button.action } }])),
    },
  } as unknown as LinkCardV2;
  return {
    kind: "card",
    url,
    app: { name: answer.app.name, icon: answer.app.icon, ...(answer.app.reviewed === false ? { reviewed: false as const } : {}) },
    title: signed[0]!.button.label,
    cardV2: card,
    actions: signed.map(({ button, handle }) => ({ action_id: button.action.action_id, handle })),
    businessRevision: answer.card_revision,
    readAt: read.readAt,
    ...(Object.keys(sealsTo).length ? { sealsTo } : {}),
    ...(view ? { view } : {}),
  };
}

/** How long after Allow the press that asked for it is still continued (MessageCardActingButtons.tsx). */
export const MESSAGE_CARD_RESUME_PRESS_MS = 15_000;

/**
 * Whether the press that opened the App's first-view prompt goes on by itself
 * once the viewer allowed the App and the card was read again. Only when
 * Raft's own dialog still stands between that press and anything running: a
 * `confirm: "prepare"` button, or any acting button of an App Raft hasn't
 * reviewed (RFC 076 §17). An undo-window button of a reviewed App would run
 * with "Allow" as its last click, and Allow answers who the App may know, not
 * whether to run the action: that one is pressed again. Never after
 * MESSAGE_CARD_RESUME_PRESS_MS, nor for another revision of the card.
 */
export function messageCardPressResumes({ button, reviewed, allowedAt, allowedRevision, revision, now }: {
  button: MessageCardActingButton;
  reviewed: boolean;
  allowedAt: number;
  allowedRevision: number;
  revision: number;
  now: number;
}): boolean {
  if (allowedRevision !== revision || now - allowedAt > MESSAGE_CARD_RESUME_PRESS_MS) return false;
  return "confirm" in button.action || !reviewed;
}
