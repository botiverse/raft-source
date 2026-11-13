/**
 * slock.context_view — what a person saw and got when opening View Context on
 * an agent's message (#wg-ax:#28). The Server and the daemon record every view
 * that reaches them (`server.agent_context_view.answered`), and none had failed
 * when people reported "clicked View Context, nothing happened"; the web
 * recorded nothing, so these three steps tell apart: no item to click yet, an
 * item hidden by a failed check, and a slow answer.
 *
 * Fields (closed sets; no agent, message or person id, no content):
 *   step       menu_opened | clicked | result
 *   status     menu_opened: the check's state when the menu opened, or what it
 *              settled to while the menu stayed open — pending | allowed |
 *              not_allowed | failed
 *   wait_ms    menu_opened: how long the menu waited for that state (0 when an
 *              answer was already kept)
 *   outcome    result: ok | not_found | offline | old_daemon | too_large |
 *              not_allowed | network_error | other
 *   total_ms   result: from the context request to its answer (the click opens
 *              the panel, which asks right away once the check allows it)
 */
import { emitWebEvent } from "./webAuthTrace";

const CONTEXT_VIEW = "slock.context_view" as const;

export type ContextViewMenuStatus = "pending" | "allowed" | "not_allowed" | "failed";
export type ContextViewResultOutcome = "ok" | "not_found" | "offline" | "old_daemon" | "too_large" | "not_allowed" | "network_error" | "other";

const RESULT_OUTCOMES: ReadonlySet<string> = new Set(["ok", "not_found", "offline", "old_daemon", "too_large", "not_allowed", "network_error"]);

type Emitter = typeof emitWebEvent;
let emitter: Emitter = emitWebEvent;

/** Test seam. */
export function __setContextViewEmitterForTest(next: Emitter | null): void {
  emitter = next ?? emitWebEvent;
}

function emit(attrs: Record<string, unknown>): void {
  try {
    emitter(CONTEXT_VIEW, attrs);
  } catch {
    // Reporting must never affect the menu or the panel.
  }
}

export function reportContextViewMenuOpened(status: ContextViewMenuStatus, waitMs: number): void {
  emit({ step: "menu_opened", status, wait_ms: Math.max(0, Math.round(waitMs)) });
}

export function reportContextViewClicked(): void {
  emit({ step: "clicked" });
}

/** `outcome` is a failure reason the Server sent, or one of the web's own; anything else is `other`. */
export function reportContextViewResult(outcome: string, totalMs: number): void {
  emit({ step: "result", outcome: RESULT_OUTCOMES.has(outcome) ? outcome : "other", total_ms: Math.max(0, Math.round(totalMs)) });
}
