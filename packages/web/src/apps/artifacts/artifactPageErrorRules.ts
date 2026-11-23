import type { ArtifactFramedKind } from "@botiverse/raft-shared";

// Which errors a framed page reports reach the viewer's page-error bar (useArtifactPageErrors):
// plain rules, no store or DOM, so a node test reads them as they are.

/**
 * A browser's notice that isn't the page's error: "ResizeObserver loop completed with undelivered
 * notifications" (Chrome, Firefox; older Chrome said "ResizeObserver loop limit exceeded") is raised
 * when an observed element is resized again inside the same frame, as a diagram re-laid out on
 * Raft's Diagram/Code switch does. Nothing failed and nothing was lost (the notifications come next
 * frame), so the bar doesn't offer it to the agent (#proj-workspace:#324). Whatever the shell put in
 * front of it ("Uncaught", "Error:") or after it (Porthole's " (line N)") doesn't matter.
 */
const BENIGN_PAGE_ERROR = /^(?:uncaught\s+)?(?:error:\s*)?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?(?: \(line \d+\))?$/i;

export function isBenignPageError(message: string): boolean {
  return BENIGN_PAGE_ERROR.test(message.trim());
}

/**
 * Whose code an error in the frame comes from (xxchan, #proj-workspace:#324): an HTML page is the
 * agent's own code, so its errors are the agent's to fix; a Markdown or PDF version is data Raft
 * draws, so an error there is Raft's renderer, which no agent can fix (and Markdown isn't publish
 * checked either, #217). Only an HTML page's errors reach the bar.
 */
export function pageErrorsAreTheAgents(kind: ArtifactFramedKind): boolean {
  return kind === "html";
}
