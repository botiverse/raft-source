import { PAGE_COMMENT_COOLDOWN_MS } from "./artifactPageComments";

/**
 * How often a page may open something of Raft's by itself: the comment box its button asks for,
 * or, for a reader who can't comment here, the question to comment on their own copy.
 *
 * No proof of a click is asked of the page (Porthole's default since 0.16.0), so the page alone decides
 * when it calls. What it opens does nothing by itself, but it is in the person's way, and a page
 * that opens it again each time it is closed would leave them no page to read. Raft can't tell a
 * press from a call, so it doesn't try: it counts what the person does with what was opened.
 *
 * - As before, at most one open a second.
 * - Closed by the person with nothing done in it, PAGE_OPEN_FREE_CLOSES times in a row: the page
 *   then waits 4 s, 16 s, then a minute for each open after (PAGE_OPEN_WAITS_MS), and hears false
 *   until then. Three closes are free because a person does that: opens, cancels, presses the
 *   page's button again (xxchan's own report, #proj-workspace:#271, was exactly that press).
 * - Anything the person does in what was opened (the cursor put in the box, a word typed, Fork
 *   chosen) ends the count, and so do two minutes without an open.
 *
 * Raft's own Comment button never goes through this.
 */
export const PAGE_OPEN_FREE_CLOSES = 3;
export const PAGE_OPEN_WAITS_MS: readonly number[] = [4_000, 16_000, 60_000];
export const PAGE_OPEN_FORGET_MS = 120_000;

export interface PageOpenGate {
  /** The person did something in what the page opened: it wasn't in their way. */
  acted(): void;
  /**
   * Whether the page may open now, and counted as an open when it may. `stillOpen`: what it last
   * opened is still there (the page moving its own box is no close).
   */
  ask(now: number, stillOpen: boolean): boolean;
}

export function createPageOpenGate(): PageOpenGate {
  let lastOpen = Number.NEGATIVE_INFINITY;
  // How many opens in a row the person closed with nothing done in them.
  let closes = 0;
  let acted = false;
  return {
    acted() {
      acted = true;
    },
    ask(now, stillOpen) {
      const opened = lastOpen !== Number.NEGATIVE_INFINITY;
      const before = opened && now - lastOpen <= PAGE_OPEN_FORGET_MS ? closes : 0;
      const next = !opened || acted ? 0 : stillOpen ? before : before + 1;
      const wait = next < PAGE_OPEN_FREE_CLOSES
        ? PAGE_COMMENT_COOLDOWN_MS
        : PAGE_OPEN_WAITS_MS[Math.min(next - PAGE_OPEN_FREE_CLOSES, PAGE_OPEN_WAITS_MS.length - 1)]!;
      if (now - lastOpen < wait) return false;
      closes = next;
      lastOpen = now;
      acted = false;
      return true;
    },
  };
}
