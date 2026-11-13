/**
 * Embedded-WebView contract.
 *
 *   ?embed=raft-settings-v1&shell=host
 *
 * The mobile app renders Marketplace / Billing / Administration inside an in-app
 * WebView that draws its OWN native title bar. Web must therefore not draw a second
 * one. Before this contract the client hid ours by injecting CSS and running a
 * `MutationObserver` over our DOM — a "contract" web never agreed to, that cannot be
 * tested, and that silently misaligns the day we change our markup. It never errors;
 * it only rots. This replaces it with a real interface web owns and can pin.
 *
 * ── Why two dimensions (@MingQi) ───────────────────────────────────────────
 * `embed` says "I am embedded". `shell` says "who owns the title bar". Collapsing
 * them (my first cut used a bare `embed=1`) silently assumes every embed is
 * host-shell, so a future embed WITHOUT a native title bar would have no way to keep
 * our header without corrupting the meaning of `embed`.
 *
 * ── Why this is read synchronously, at module load ──────────────────────────
 * If the decision lived in a `useEffect`, the first frame would paint the header and
 * then remove it — a visible flash — while every functional test stayed green,
 * because the header IS gone by the time the test asserts. The URL is available
 * synchronously; there is no reason to defer it, and every reason not to.
 *
 * ── Why it is latched, and ALSO preserved in the URL ────────────────────────
 * React Router navigation drops the query string by default (`navigate("/x")`), and
 * stale or replacing `setSearchParams` writes can wipe params owned by other surfaces —
 * this repo has been bitten more than once (#760 / #780 / #795 / #2249). So
 * a navigation would silently un-embed the app and the header would grow back.
 *   - LATCH (module-level, read once): survives any navigation that drops the query.
 *   - PRESERVE (in the URL): survives a WebView cold start / reload / OS kill —
 *     the URL is the only thing that lives through that, and a latch does not.
 * Drop either half and you get a bug that never errors: one day the header appears.
 *
 * ── Who honours it ─────────────────────────────────────────────────────────
 * The settings surfaces above, and the signed-in Artifact page (`/artifacts/<id>`,
 * `/v/<n>`; ArtifactStandalonePage, mobile #3866): the App opens an Artifact with
 * this same value, draws Back, the title and the version natively, and the page
 * keeps only its toolbar (where it lives, its original message, Comments, ⋯). Not a
 * new version: the meaning ("the native shell owns the title bar") is the same.
 * `back=host` with the host shell (#proj-workspace:#264): the App draws no title bar
 * over the Artifact page after all, so the page's toolbar starts with Back, which asks
 * the App to close it by setting the hash to `#host=close` (artifactPageOpening). Latched
 * and kept in the URL with the rest.
 *
 * `hostMenu=desktop-mode,open-in-browser` with the host shell (Lagoon, artin: one top bar in the App's Artifact
 * viewer, mobile #4635): the App offers these items of its own, and lets the page draw the only bar once it says it
 * does. The page's toolbar then carries the title and version too, its ⋯ starts with the items named (each asks the
 * App through `#host=<item>`), and once drawn the page writes `hostToolbar=1`; the App drops its own bar after that.
 * `hostDesktop=on|off` is the App's Desktop mode, which the App keeps current in the query and announces with a
 * `raft:host-state` event on the window. All three are kept in the URL by the keeper: a navigation that dropped
 * `hostToolbar` would bring the App's bar back over the page's.
 *
 * Legacy `embed=1` is deliberately NOT supported (@artin: 不用兼容). An old client
 * therefore falls back to a normal page — one extra web header, not a double header.
 */

export type EmbedShell = "host" | "web";

export interface EmbedMode {
  /** True when this document is rendered inside a client WebView. */
  embedded: boolean;
  /**
   * Who draws the title bar.
   *  - "host": the native shell already draws one ⇒ web must not draw a second.
   *  - "web":  no native title bar ⇒ web keeps its PanelHeader.
   */
  shell: EmbedShell;
  /**
   * `chrome=none` with the host shell: the native shell draws the page's
   * toolbar too (an Artifact's place, presence and actions, #proj-workspace:#127),
   * so the page draws only its content. Latched with the rest.
   */
  chromeless?: true;
  /**
   * `back=host` with the host shell: the App draws no Back of its own, so the page's
   * toolbar does, and its tap asks the App to close the page (`#host=close`,
   * #proj-workspace:#264). Latched with the rest, and kept in the URL by the keeper.
   */
  hostBack?: true;
  /**
   * `hostMenu=<items>` with the host shell: the App's own menu items, for the page's ⋯ (known names only, in the
   * App's order). Present only when at least one is known. Latched with the rest, and kept in the URL by the keeper.
   */
  hostMenu?: readonly HostMenuItem[];
}

/** An item of the App's own that the page's ⋯ offers, asked for through `#host=<item>` (artifactPageOpening). */
export type HostMenuItem = "desktop-mode" | "open-in-browser";

const HOST_MENU_ITEMS: readonly HostMenuItem[] = ["desktop-mode", "open-in-browser"];

function parseHostMenu(value: string | null): HostMenuItem[] {
  if (!value) return [];
  const named = value.split(",").map((item) => item.trim());
  return named.filter((item, index): item is HostMenuItem => (HOST_MENU_ITEMS as readonly string[]).includes(item) && named.indexOf(item) === index);
}

/** The only value we recognise. An unknown version falls back to a normal page. */
const SUPPORTED_EMBED = "raft-settings-v1";

const NOT_EMBEDDED: EmbedMode = { embedded: false, shell: "web" };

export function parseEmbedMode(search: string): EmbedMode {
  const params = new URLSearchParams(search);
  const embed = params.get("embed");
  // Unknown/absent version ⇒ normal page. Forward-compat: a future client can ship a
  // v2 value against an older web build and get a plain page, never a broken one.
  if (embed !== SUPPORTED_EMBED) return NOT_EMBEDDED;
  const shell = params.get("shell") === "web" ? "web" : "host";
  if (shell === "web") return { embedded: true, shell };
  return {
    embedded: true,
    shell,
    ...(params.get("chrome") === "none" ? { chromeless: true as const } : {}),
    ...(params.get("back") === "host" ? { hostBack: true as const } : {}),
    ...hostMenuOf(params),
  };
}

function hostMenuOf(params: URLSearchParams): { hostMenu?: readonly HostMenuItem[] } {
  const items = parseHostMenu(params.get("hostMenu"));
  return items.length > 0 ? { hostMenu: items } : {};
}

/**
 * The LATCH. Computed on first read from the ENTRY url, then frozen for the session.
 *
 * Memoised rather than computed at module-load only so tests can isolate cases; it is
 * still SYNCHRONOUS, and the first read happens during the first render, so the very
 * first frame already knows. That is the whole point: a `useEffect` would paint the
 * header on frame 1 and delete it on frame 2 — a flash the user sees and every
 * "final DOM" assertion happily calls green.
 *
 * Latched (rather than re-read per navigation) because React Router drops the query
 * string on `navigate("/x")`, and stale or replacing `setSearchParams` writes can wipe
 * params owned by other surfaces — this repo has been bitten more than once
 * (#760/#780/#795/#2249). Without the latch, one navigation silently un-embeds the app.
 */
let latched: EmbedMode | null = null;

export function getEmbedMode(): EmbedMode {
  if (latched === null) {
    latched = typeof window === "undefined" ? NOT_EMBEDDED : parseEmbedMode(window.location.search);
  }
  return latched;
}

/** Test seam: force the latched mode, and get back a function that restores it. */
export function __setEmbedModeForTests(mode: EmbedMode | null): () => void {
  const previous = latched;
  latched = mode;
  return () => {
    latched = previous;
  };
}

/** True when the native shell owns the title bar ⇒ web renders no header chrome. */
export function isHostShell(): boolean {
  const mode = getEmbedMode();
  return mode.embedded && mode.shell === "host";
}

/** True when the native shell also draws the page's toolbar (`chrome=none`) ⇒ web renders only the content. */
export function isChromeless(): boolean {
  const mode = getEmbedMode();
  return mode.embedded && mode.shell === "host" && mode.chromeless === true;
}

/** True when the page draws Back for the App (`back=host` with the host shell) ⇒ its tap sets `#host=close`. */
export function hasHostBack(): boolean {
  const mode = getEmbedMode();
  return mode.embedded && mode.shell === "host" && mode.hostBack === true;
}

const NO_HOST_MENU: readonly HostMenuItem[] = [];

/** The App's own items for the page's ⋯ (`hostMenu=`, with the host shell): none when it declared none. */
export function hostMenuItems(): readonly HostMenuItem[] {
  const mode = getEmbedMode();
  return mode.embedded && mode.shell === "host" ? mode.hostMenu ?? NO_HOST_MENU : NO_HOST_MENU;
}

/**
 * Whether the page has drawn the only bar (title, version and the App's items), so the App may drop its own:
 * `hostToolbar=1`, written once the toolbar is up and kept by the keeper from then on. Only for an App that
 * declared `hostMenu`; an older one draws its own bar whatever the page writes.
 */
let toolbarDrawn = false;

export function hostToolbarDrawn(): boolean {
  return toolbarDrawn;
}

/** Marks the page's bar drawn: the keeper then writes `hostToolbar=1` (and keeps it). A no-op without `hostMenu`. */
export function markHostToolbarDrawn(): boolean {
  if (toolbarDrawn || hostMenuItems().length === 0) return false;
  toolbarDrawn = true;
  return true;
}

/**
 * The App's Desktop mode as last seen (`hostDesktop=on|off`): read from the address as it is now, which the App
 * keeps current, and remembered so the keeper can put it back where a navigation dropped the query. null: the App
 * never said (or declared no `desktop-mode` item).
 */
let lastHostDesktop: boolean | null = null;

export function readHostDesktop(search: string): boolean | null {
  if (!hostMenuItems().includes("desktop-mode")) return null;
  const value = new URLSearchParams(search).get("hostDesktop");
  if (value === "on" || value === "off") lastHostDesktop = value === "on";
  return lastHostDesktop;
}

/** The window event the App fires after changing `hostDesktop` in the address. */
export const HOST_STATE_EVENT = "raft:host-state";

/**
 * MERGE the embed params into an existing query string — never overwrite it.
 *
 * @铁根: overwriting is the bug this repo already fixed three times. The bare-object
 * form of `setSearchParams` replaces the WHOLE query, silently dropping params owned
 * by other surfaces (`thread`, `profile`, `agentTab`, …) — #760 / #780 / #795 / #2249.
 * So we take the caller's params and add ours, touching nothing else.
 *
 * Returns the SAME instance when nothing changed. NOTE: that is NOT enough to skip a
 * write — React Router navigates inside `setSearchParams` regardless of what the
 * updater returns. Callers must gate on `needsEmbedRepair()` BEFORE calling the setter.
 */
export function withEmbedParams(current: URLSearchParams): URLSearchParams {
  const mode = getEmbedMode();
  if (!mode.embedded) return current;
  if (!needsEmbedRepair(`?${current.toString()}`)) return current;
  const next = new URLSearchParams(current); // copy — every other param survives
  next.set("embed", SUPPORTED_EMBED);
  next.set("shell", mode.shell);
  // `back=host` too: a reload after a navigation that dropped the query must still draw the page's Back
  // (the App draws none, so without it there would be no way out).
  if (mode.hostBack) next.set("back", "host");
  // The App's items and the bar's flag, so a reload keeps one bar; Desktop mode only where the query lost it (the App
  // writes it, and a value it wrote is never overwritten with an older one).
  if (mode.hostMenu && !next.has("hostMenu")) next.set("hostMenu", mode.hostMenu.join(","));
  if (toolbarDrawn) next.set("hostToolbar", "1");
  if (lastHostDesktop !== null && !next.has("hostDesktop")) next.set("hostDesktop", lastHostDesktop ? "on" : "off");
  return next;
}

/**
 * Does this query string NEED the embed params written into it?
 *
 * This exists to be checked BEFORE calling `setSearchParams`, and that is not a
 * micro-optimisation — it is the difference between one write and an unbounded stream
 * of them (@MingQi).
 *
 * React Router's `setSearchParams` calls `navigate("?" + params, options)` INSIDE the
 * setter, unconditionally: returning `prev` unchanged from a functional updater does
 * NOT skip the write. And the setter's own identity churns on every location change,
 * so an effect that lists it in deps re-fires after each write. An earlier version of
 * this file claimed "same instance ⇒ no write, no history churn" — that is simply not
 * true in React Router, and nothing could have caught it, because the tests asserted
 * the final URL and no test counted Router writes.
 *
 * So the guard has to live OUT HERE, in a pure function over the current search string,
 * where a test can count exactly how many times we ask the Router to do anything.
 */
export function needsEmbedRepair(search: string): boolean {
  const mode = getEmbedMode();
  if (!mode.embedded) return false; // not embedded ⇒ never touch the URL, ever
  const params = new URLSearchParams(search);
  return params.get("embed") !== SUPPORTED_EMBED || params.get("shell") !== mode.shell || (mode.hostBack === true && params.get("back") !== "host")
    || (mode.hostMenu !== undefined && !params.has("hostMenu"))
    || (toolbarDrawn && params.get("hostToolbar") !== "1")
    || (lastHostDesktop !== null && !params.has("hostDesktop"));
}

/** Test seam. Production never resets: the mode is decided once, at entry. */
export const __embedTestInternals = {
  parseEmbedMode,
  SUPPORTED_EMBED,
  reset: () => { latched = null; toolbarDrawn = false; lastHostDesktop = null; },
};

/**
 * Whether this document shows the chat surfaces (sidebar, rail, channels, inbox).
 *
 * A host-shell embed renders one settings surface inside a native app: Computers,
 * a computer, or a settings tab. None of them reads the channel list, DMs, unread
 * counts, the inbox, saved messages, followed threads, the sidebar order or
 * announcements, so the startup loads for those are skipped there. On a phone that
 * is most of the requests the page used to issue before its own data.
 */
export function hasChatSurfaces(): boolean {
  return !isHostShell();
}
