// The toasts link-card actions show (RFC 076 §6.6, §6.9): Raft's fixed hint
// per operation state, warnings, and the App's own words when an operation
// ends, always in the tone Raft gives the state. Split out of linkCardExecute.tsx.
import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import type { LinkCardOperationState } from "./linkCardExecute";

type Format = IntlShape["formatMessage"];

/** Raft's fixed hint per state, localized (the server's English text is the same copy). */
const STATE_HINTS: Record<LinkCardOperationState, { id: MessageId; tone: "info" | "success" | "warning" }> = {
  sent: { id: "message.appLink.action.state.sent", tone: "info" },
  accepted: { id: "message.appLink.action.state.accepted", tone: "info" },
  done: { id: "message.appLink.action.state.done", tone: "success" },
  refused: { id: "message.appLink.action.state.notCarriedOut", tone: "warning" },
  failed_not_sent: { id: "message.appLink.action.state.notCarriedOut", tone: "warning" },
  unknown: { id: "message.appLink.action.state.unconfirmed", tone: "warning" },
  needs_reconciliation: { id: "message.appLink.action.state.unconfirmed", tone: "warning" },
  resolved_manually: { id: "message.appLink.action.state.resolvedManually", tone: "info" },
};
export function showToast(tone: "info" | "success" | "warning", text: string) {
  if (tone === "success") toast.success(text);
  else if (tone === "warning") toast.warning(text);
  else toast.info(text);
}
export const showStateHint = (format: Format, state: LinkCardOperationState) => showToast(STATE_HINTS[state].tone, format({ id: STATE_HINTS[state].id }));
// The App behind each card whose button was pressed in this tab, by view key,
// so its words can be shown under its name (pressLinkCardButton notes it).
// Names only, in memory: nothing of the App is kept in the local records, so
// an operation recovered after a reload has no name here.
const appNames = new Map<string, string>();
export function noteLinkCardApp(viewKey: string, name: string) {
  if (name.trim()) appNames.set(viewKey, name.trim());
}
/**
 * The App's words for an operation in `state` (RFC 076 §6.9): the App picks
 * the text, never the colour, which is the tone Raft gives that state, so a
 * refusal never shows as a success. Blank text is no toast: false, and the
 * caller shows Raft's hint instead (Kirby, #13978 review W1, W4). The words
 * are shown as the App's, "Stamp: Merged", never as Raft's own sentence (W3);
 * an operation recovered after a reload, whose press this tab didn't see,
 * names no App: "App: …".
 */
export function showAppToast(format: Format, state: LinkCardOperationState, toast: { text: string } | undefined, viewKey: string | undefined): boolean {
  const text = toast?.text.trim();
  if (!text) return false;
  const app = viewKey ? appNames.get(viewKey) : undefined;
  showToast(STATE_HINTS[state].tone, app ? format({ id: "message.appLink.action.appSays" }, { app, text }) : format({ id: "message.appLink.action.appSaysUnnamed" }, { text }));
  return true;
}
export const showWarning = (format: Format, id: MessageId, values?: Record<string, string | number>) => showToast("warning", format({ id }, values));
