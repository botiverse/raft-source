/**
 * The colours a Markdown Artifact's page takes from Raft's theme: each Raft token it draws with
 * (raft-ui's foundation.css and themes.css), and the light value the page shows without a theme.
 *
 * One table for the three sides that must agree: the content Worker's config and renderer
 * (packages/content-worker/src/raftContentDisplays.ts, markdown.ts) and the web's frame
 * (packages/web/src/apps/artifacts/ArtifactFrame.tsx).
 *
 * The page reads `--raft-<token>` rather than Porthole's default `--color-*` names on purpose. The
 * shell writes every name in its config onto the page's root from whatever the host sends, and a
 * host with no value for one sends the config's default. So a default name is always set inside a
 * frame, to Porthole's neutral colours, and `var(--color-background-primary, #fff)` would never
 * reach its fallback; a Raft name is unset under an older host, and its default here is the
 * fallback. And HTML Artifacts, which may use the default names, keep them.
 *
 * Colours only: a token added here must hold a colour (web's artifactPageTheme test).
 *
 * The page can read these, so it can tell which preset theme a signed-in viewer uses, in light as
 * well (`--layer-sidebar` changes with it there), which says little (Tenny, #13468, #13482). If a
 * server theme ever takes arbitrary colours, these values would tell a page which server the viewer
 * comes from: then send presets only, or nothing to HTML and scripted pages.
 */
export const ARTIFACT_PAGE_COLORS = {
  "--layer-canvas": "#fff",
  // The ground outside the document, and the card it sits in. Equal without a theme, which is what
  // keeps the card away (markdown.ts, `data-raft-card`): not to be given different fallbacks.
  "--layer-sidebar": "#fff",
  "--layer-card": "#fff",
  "--layer-code": "#fff",
  "--layer-backdrop": "rgba(0,0,0,.85)",
  "--foreground": "oklch(0.1813 0.005 17.62)",
  "--foreground-muted": "oklch(0.1813 0.005 17.62 / 0.678)",
  "--foreground-hint": "oklch(0.1813 0.005 17.62 / 0.62)",
  "--foreground-link": "oklch(0.4878 0.2432 264.4)",
  "--line-hairline": "oklch(0.1813 0.005 17.62 / 0.149)",
  "--line-seam": "oklch(0.1813 0.005 17.62 / 0.451)",
  "--fill-muted": "oklch(0.9642 0 0)",
  "--fill-medium": "oklch(0.1813 0.005 17.62 / 0.078)",
  "--brand-400": "oklch(0.883 0.162 91.89)",
  // The ink on brand-400, which stays a bright colour in dark.
  "--sticker-ink": "oklch(0.1813 0.005 17.62)",
  "--warning-soft": "oklch(0.9413 0.0275 40.2)",
} as const;

/**
 * From this width (the frame's, in CSS px) a Markdown page under a theme sits in a card on the
 * sidebar's ground (`--layer-sidebar`); narrower, it is on the canvas (`--layer-canvas`) with no
 * card, no tint and no sheet: the text sits on the page. The sheet is for a page with wide empty
 * space on both sides of its column (Kirby, xxchan): the column is 48rem (768 px), so from 1024 px
 * there are 128 px or more of ground on each side; a medium page, a tinted ground with the sheet
 * reaching its edges, only looked as if the document didn't fill it. The content Worker's template
 * draws it (markdown.ts, `data-raft-card`), and the web's margin of comment cards beside the page
 * paints the same ground (artifactPageGround), so the two read as one page (#proj-workspace:#245):
 * one number for both.
 */
export const ARTIFACT_PAGE_CARD_MIN_WIDTH_PX = 1024;

export type ArtifactPageToken = keyof typeof ARTIFACT_PAGE_COLORS;

const TOKENS = Object.keys(ARTIFACT_PAGE_COLORS) as ArtifactPageToken[];

/** The name a token has on the page: `--layer-canvas` is `--raft-layer-canvas`. */
export function artifactPageVariable(token: ArtifactPageToken): string {
  return `--raft-${token.slice(2)}`;
}

/** Porthole's `theme.variables`: the names the shell may set, each with the page's light value. */
export const ARTIFACT_PAGE_THEME_VARIABLES: Readonly<Record<string, string>> = Object.fromEntries(
  TOKENS.map((token) => [artifactPageVariable(token), ARTIFACT_PAGE_COLORS[token]]),
);

/** For Porthole's `cssVariableTheme`: each page name and the Raft token it is read from. */
export const ARTIFACT_PAGE_THEME_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  TOKENS.map((token) => [artifactPageVariable(token), token]),
);
