import { asArtifactCommentId } from "@botiverse/raft-shared";
import type { ArtifactCommentId } from "@botiverse/raft-shared";
import type { HostMenuItem } from "../../embed";

/** What the Artifact page's address asks it to open with (#proj-workspace:#127, the App). */
export interface ArtifactPageOpening {
  /** `?panel=comments` opens the comment list, `?panel=versions` the version list, `?panel=files` the Files panel; anything else, none. */
  panel: "comments" | "versions" | "files" | null;
  /** `?comment=<id>`: the comment it lands on, as an Activity row does (ArtifactCommentsProvider's `landOn`). */
  comment: ArtifactCommentId | null;
}

// A comment's id as the server gives it (`c_<uuid>`, or `lc_<id>` for one copied from raft-artifacts.com).
const COMMENT_ID = /^l?c_[0-9A-Za-z-]{1,80}$/;

/** Read from the address the page was opened at; malformed values are ignored, never an error. */
export function artifactPageOpening(search: string): ArtifactPageOpening {
  const params = new URLSearchParams(search);
  const panel = params.get("panel");
  const comment = params.get("comment");
  return {
    panel: panel === "comments" || panel === "versions" || panel === "files" ? panel : null,
    comment: comment !== null && COMMENT_ID.test(comment) ? asArtifactCommentId(comment) : null,
  };
}

/** The list open in the page, as the App's address says it (`#panel=`): written by the App and by the page. */
export type ArtifactPagePanel = "comments" | "versions" | "files" | "none";

/**
 * `#panel=comments`, `#panel=versions`, `#panel=files` or `#panel=none` (the App asks; Lagoon,
 * #proj-workspace:#127): null for any other hash, which the page leaves alone.
 */
export function artifactPanelFromHash(hash: string): ArtifactPagePanel | null {
  const match = /^#panel=(comments|versions|files|none)$/.exec(hash);
  return match ? (match[1] as ArtifactPagePanel) : null;
}

/** The hash that says which list is open: none open is no hash at all. */
export function artifactHashForPanel(panel: ArtifactPagePanel): string {
  return panel === "none" ? "" : `#panel=${panel}`;
}

/**
 * `#host=<action>`: the page asks the App for something of its own: `close` (Back in the App's toolbar, `back=host`,
 * embed.ts; Lagoon, #proj-workspace:#264), or an item of the App's menu it declared (`hostMenu`, embed.ts:
 * `desktop-mode`, `open-in-browser`; mobile #4635, which ignores any other name). Like `#panel=`, a hashchange the
 * App watches, no bridge. Not a panel: artifactPanelFromHash ignores it, and the page's `#panel=` write-back may
 * replace it.
 */
export type ArtifactHostAction = "close" | HostMenuItem;

export const ARTIFACT_HOST_CLOSE_HASH = "#host=close";

/** Whether a hash is one of these requests (the page's `#panel=` write-back may replace it). */
export function isArtifactHostActionHash(hash: string): boolean {
  return /^#host=[a-z-]+$/.test(hash);
}

/**
 * Sets the hash to `#host=<action>` so that a hashchange fires every time, even when it already is
 * (the App didn't act on the last tap): then it is first taken off without an event
 * (replaceState), and set again. Replaced, never pushed, as the page's `#panel=` writes: a tap leaves
 * no history entry behind if the App stays open.
 */
export function requestArtifactHostAction(action: ArtifactHostAction): void {
  const url = new URL(window.location.href);
  const hash = `#host=${action}`;
  if (url.hash === hash) {
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }
  url.hash = hash;
  window.location.replace(url.href);
}

/** `#host=close`: Back in the App's toolbar (`back=host`). */
export function requestArtifactHostClose(): void {
  requestArtifactHostAction("close");
}
