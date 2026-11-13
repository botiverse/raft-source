// Confirm dialogs and undo toasts (AndyLok, #proj-o11y:#16; #proj-analytics:#17):
// do people go through with the actions we ask them to confirm, and how often
// do they undo one they could undo. Enums only.
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

export type ConfirmDialogName = ProductEventProperties<"confirm_dialog_closed">["dialog"];
export type UndoableAction = ProductEventProperties<"undo_offered">["action"];

/** A confirm dialog: `confirmed` when the person pressed the confirm (once per opening), else `cancelled` when they closed it. */
export function trackConfirmDialogClosed(dialog: ConfirmDialogName, result: "confirmed" | "cancelled"): void {
  trackEvent("confirm_dialog_closed", { dialog, result });
}

/** A toast offered to undo the action just taken; `serverId` pins it to the server the action was on. */
export function trackUndoOffered(action: UndoableAction, serverId?: string): void {
  trackEvent("undo_offered", { action }, serverId ? { serverId } : undefined);
}

/** The person pressed Undo; `superseded`: it found nothing to undo. */
export function trackUndoUsed(
  action: UndoableAction,
  result: "undone" | "superseded" | "failed" = "undone",
  serverId?: string,
): void {
  trackEvent("undo_used", { action, result }, serverId ? { serverId } : undefined);
}
