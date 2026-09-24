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
  return { embedded: true, shell };
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

/** True when the native shell owns the title bar ⇒ web renders no header chrome. */
export function isHostShell(): boolean {
  const mode = getEmbedMode();
  return mode.embedded && mode.shell === "host";
}

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
  if (current.get("embed") === SUPPORTED_EMBED && current.get("shell") === mode.shell) {
    return current;
  }
  const next = new URLSearchParams(current); // copy — every other param survives
  next.set("embed", SUPPORTED_EMBED);
  next.set("shell", mode.shell);
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
  return params.get("embed") !== SUPPORTED_EMBED || params.get("shell") !== mode.shell;
}

/** Test seam. Production never resets: the mode is decided once, at entry. */
export const __embedTestInternals = {
  parseEmbedMode,
  SUPPORTED_EMBED,
  reset: () => { latched = null; },
};
