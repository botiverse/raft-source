/**
 * How Raft's workspace Artifacts are framed (S2, the content origin): the
 * config the content Worker (src/raftContent.ts) serves each page under. The
 * Raft web mounts its frames with the same kinds (Porthole's React frame), so
 * the shell in the frame and the host agree; a change here is a change there.
 *
 * Porthole's artifact preset, domain isolation: the frame is
 * `sandbox="allow-scripts allow-same-origin"` and every page's CSP carries
 * the same `sandbox` (P099). No popups, no top navigation: links go to the
 * host through `openLink`, which Raft opens in a new tab with `noopener`.
 *
 * Porthole 0.16.0 (0.12 from Tenny, 2026-10-26), for `comments` (P090, P108,
 * P109: `comments.open(anchor, { draft })` opens Raft's composer at the page's
 * anchor; the page never reads or posts a comment) and the comment mode's
 * annotations (P112, P115-P117; P118 is the web's React binding only; 0.14.3's
 * P119 is the shell's: on touch, a marker's tap area is at least 44×44; 0.14.4's P120-P122 harden
 * nested pages, which stay off here; 0.14.6's P125 and 0.14.7's P126 the door,
 * which this Worker answers at its own path: raftContentService.ts `openDoor`; 0.14.9's P131, the
 * shell's find in page for Raft's find bar; 0.14.10's P132, the shell's: a mark's place in the
 * document and the document's scroll in its reports, for the web's Markdown margin; 0.14.11's P133,
 * the shell's: markers are labelled buttons in the frame's Tab order, a posted one at its paragraph's
 * end, and reports say where the last line is, for the web's Comment button; 0.14.12's P134, the
 * shell's: `focusMark` puts the keyboard back on a marker, and a marker's name is its words, in
 * quotes, without an element's tag; 0.14.13's P135 and 0.14.14's P137, the shell's: a `focusMark`
 * that waited or came late (100 ms) lands only with the focus in the frame, which the web's second
 * call after its own move covers; 0.14.14's P136, `display.focus()` through a nested page's shell, not
 * served here; 0.14.15's P138 and 0.14.16's P140, the shell's following of the selection, which the
 * web doesn't ask yet, so a pick's outline goes with it as before; 0.14.16's P139, the shell's: on a
 * tab it asks no host and says so on the root, `data-porthole-host`, which the publish check reads;
 * 0.15.0's P143, the server's embed grants, which raftContentService.ts `openEmbed` alone mints: the
 * displays don't change, the grant makes the plan hostless; 0.15.1's P145, the embeds audit: the
 * host kit refuses an `access` answer with `embed`, which Raft never gives, and a host origin's or
 * `framedBy`'s port and host must be as a browser serializes them, which Raft's are; 0.15.2's P147,
 * annotations': a comment's highlight and marker ride the document's scroll, moved by a scroll
 * timeline in the shell's layer, where they trailed the text until the scroll event was heard;
 * 0.16.0's P149: no proof of a click is asked of a page's calls but `copyText`'s, and nested
 * pages and the focus guard are removed, so the nested notes above are history).
 * The shell is this Worker's, so its
 * `@botiverse/porthole` upgrades first and Raft's web (packages/web), which
 * mounts these frames, follows; the web is never ahead
 * (test/workspace-porthole.test.ts).
 *
 * Porthole 0.16.0 removed nested pages (its P149): every page here is a served
 * one, framed on its scope's own label.
 */
import { defineDisplays, LIBRARY_CDNS } from "@botiverse/porthole";
import { ARTIFACT_PAGE_THEME_VARIABLES } from "@botiverse/raft-shared/src/artifactPageTheme";

/** The label prefix: Artifact `pt_<uuid>` is served on `w-<uuid>.<content domain>`. */
export const RAFT_LABEL_PREFIX = "w-";

export const raftDisplays = defineDisplays({
  artifact: {
    preset: "artifact",
    options: {
      // As the standalone Raft Artifacts app's own pages: Porthole's library CDNs, nothing else.
      egress: LIBRARY_CDNS,
      // Porthole's capability runtime (P085), contract "1": `comments` is one of its host
      // functions, so only a config with a runtime may offer it. Pages reach it as a built-in,
      // without declaring it (and 0.6's globals stay as they were).
      runtime: "1",
      // `comments`: Raft opens its composer at the anchor, with the page's draft (P108).
      // `annotate` (P053, P104, P107): Raft's comment mode drives it (what the person selects or
      // picks, the bubbles of comments and of the author's own drafts); the shell does nothing
      // until Raft starts it. `find` (P131): Raft's find bar searches the page's text; the shell
      // searches only what the host asks and takes Cmd/Ctrl+F only while the host says it draws
      // its own bar, so a frame whose host config leaves `find` out (the web decides per page,
      // its artifactFrameFind.ts: no find where the page could send the query out) never searches.
      // Kept equal to the web's RAFT_ARTIFACT_DISPLAYS (test/display-parity.test.ts).
      // `comments` and `openLink` run on Porthole's defaults, which since 0.16.0 (its P149) ask
      // no proof of a click: the shell stops no call of the page's for want of one, and the
      // web's bridge refuses none. What that check guarded is Raft's own to hold (the web's
      // artifactPageOpenGate says how). `copyText` still needs a click.
      capabilities: { annotate: {}, comments: {}, copyText: {}, find: {}, openLink: {} },
      layout: { kind: "fill" },
      errors: "host",
      // Added to Porthole's names, for the Markdown page (src/markdown.ts): colours Raft's theme
      // fills in where the web's frame sends it, else these light values. Nothing but a name each
      // on the page's root: no capability, and the CSP and sandbox don't read the theme.
      theme: { variables: ARTIFACT_PAGE_THEME_VARIABLES },
    },
    // One origin per Artifact, its versions on it.
    served: { storage: { scope: "this artifact, across its versions" } },
  },
});
