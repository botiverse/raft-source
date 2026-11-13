import { parseActionCardSpec, stripActionCardSpec } from "@botiverse/raft-shared";
import type { ActionCardRenderedCard, ActionCardSpecCapability } from "@botiverse/raft-shared";
import { isElectronDesktopShell } from "../../utils/desktopShell";
import { withOneReload } from "./actionCardTreeParts";

/**
 * What this web build can do with an `action-card.v1` card (shared
 * ACTION_CARD_SPEC_CAPABILITIES). Every other button becomes "Open in web"
 * (on the web, Reload: actionCardUnrunnableOpensInWeb).
 * - card.v1: execute, navigate (entity or public URL);
 * - confirm.v1: the confirm dialog before an execute (an action that grants
 *   permissions has its own dialog instead, by its action key:
 *   actionCardIntentFlows' useActionCardNativeConfirm);
 * - form.v1 and every field.*: the generic form sheet (ActionCardFormSheet),
 *   field.choice included (a question card's Choice, raft-ui ChoiceList);
 * - intent.feedback_form, intent.upgrade_dialog, intent.add_seats and
 *   intent.feedback_ticket: Raft's own flows (actionCardIntentFlows: the
 *   feedback dialog, the upgrade dialog, Add Seats, the sender's ticket);
 * - intent.create_channel, intent.add_members and intent.create_agent: Raft's
 *   own Create Channel, Add Members and Create Agent dialogs, prefilled from
 *   the card's action, with the native dialogs' funnel events and
 *   mark-executed (actionCardIntentFlows: useActionCardCreateDialog);
 *   intent.migrate_agent the same way, with the agent page's migration dialog.
 */
export const WEB_ACTION_CARD_SPEC_CAPABILITIES: readonly ActionCardSpecCapability[] = [
  "card.v1", "confirm.v1", "form.v1",
  "field.text_input", "field.text_area", "field.select", "field.toggle", "field.member_picker", "field.channel_picker", "field.agent_picker",
  "field.choice",
  "intent.feedback_form", "intent.upgrade_dialog", "intent.add_seats", "intent.feedback_ticket",
  "intent.create_channel", "intent.add_members", "intent.create_agent", "intent.migrate_agent",
];

/**
 * Q8 (Kirby, 2026-11-05): what a spec button this build cannot run does, the
 * button strip turned into "Open in web" (an `open` intent, a form field type
 * or a press key this build does not know). This is the one place the choice
 * is made; flip it here.
 *
 * - Raft Desktop (true): "Open in web" stays a link. It opens this message in
 *   the browser, whose web build may be newer than the one compiled into this
 *   desktop build, so it may run the button.
 * - The web (false): the link would open this same message in this same build,
 *   a loop. The button is Reload instead, beside a line saying this version of
 *   Raft can't do this yet (ActionCardSpecCard, actionCard.reloadToRun.*); a
 *   card with several such buttons shows one (readActionCardSpec).
 */
export function actionCardUnrunnableOpensInWeb(): boolean {
  return isElectronDesktopShell();
}

/** The web's Reload for such a button: the page again, from the build the server serves now. Tests replace `page` before the card renders. */
export const actionCardReload = { page: (): void => window.location.reload() };

/**
 * The card a message's `presentation.card` describes, as this client renders
 * it; null when there is none or the read parse refuses it, and the message
 * renders view only from its legacy presentation (ActionCard). The read parse
 * drops keys it doesn't know, except where they could change what a press
 * does (a button's props, its action, its confirm): that button opens in web
 * instead. On the web, where such a button is Reload, a card keeps one of them
 * (withOneReload).
 */
export function readActionCardSpec(raw: unknown, capabilities: readonly string[] = WEB_ACTION_CARD_SPEC_CAPABILITIES): ActionCardRenderedCard | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseActionCardSpec(raw, { mode: "read" });
  const card = parsed.ok ? stripActionCardSpec(parsed.card, capabilities) : null;
  return card && !actionCardUnrunnableOpensInWeb() ? withOneReload(card) : card;
}
