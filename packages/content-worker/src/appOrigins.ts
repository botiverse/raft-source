/**
 * Who may frame a page: the Raft app (APP_ORIGIN, always first) and the
 * origins of EXTRA_APP_ORIGINS, Raft's other clients that mount the same web
 * (Raft Desktop's `app://raft`); above the app, FRAMED_BY_ORIGINS (Deck), an
 * ancestor only. Shared by the Worker and the deploy's render
 * (scripts/deploy-config.ts), so both refuse the same values.
 */

/**
 * Raft Desktop's page origin: its `app` scheme is registered standard and secure
 * (apps/desktop/src/app/index.ts, `registerSchemesAsPrivileged`), so its pages have
 * this tuple origin, not an opaque one. The only non-https origin taken.
 */
export const DESKTOP_APP_ORIGIN = "app://raft";

/**
 * `https://host[:port]`, lowercase DNS labels: no wildcard, path, credentials, query or fragment.
 * The port without a leading zero, so never `:0`, which Porthole (0.15.1, P145) refuses as a host
 * origin and in `framedBy`: the deploy's render refuses it too, not the deployed Worker alone
 * (a port above 65535 or a host the URL parser rewrites fails `url.origin !== origin`).
 */
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9]\d{0,4})?$/;

/**
 * Why `origin` can't be an extra app origin; null if it can. An exact https
 * origin (as `URL.origin` gives it, of DNS labels) or exactly DESKTOP_APP_ORIGIN.
 */
export function extraAppOriginProblem(origin: string): string | null {
  if (origin === DESKTOP_APP_ORIGIN) return null;
  const url = URL.canParse(origin) ? new URL(origin) : null;
  if (url === null || !HTTPS_ORIGIN.test(origin) || url.origin !== origin)
    return `${JSON.stringify(origin)} is not an https origin (https://host[:port]) or ${DESKTOP_APP_ORIGIN}`;
  return null;
}

/**
 * EXTRA_APP_ORIGINS, a comma list: each entry checked (extraAppOriginProblem),
 * in order, without repeats. Empty or unset: none. Throws on any bad entry, so
 * a mistyped list fails closed rather than framing for fewer or other origins.
 */
export function extraAppOriginsOf(value: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (value ?? "").split(",").map((each) => each.trim())) {
    if (entry === "") continue;
    const problem = extraAppOriginProblem(entry);
    if (problem !== null) throw new Error(`EXTRA_APP_ORIGINS: ${problem}`);
    if (!origins.includes(entry)) origins.push(entry);
  }
  return origins;
}

/** APP_ORIGIN's origin first, then the extra ones it doesn't already name. */
export function appOriginsOf(appOrigin: string, extra: string | undefined): string[] {
  const primary = new URL(appOrigin).origin;
  return [primary, ...extraAppOriginsOf(extra).filter((origin) => origin !== primary)];
}

/**
 * FRAMED_BY_ORIGINS, a comma or space list: the origins of a page that frames
 * the Raft app itself (Deck), passed to Porthole as `framedBy` (P141). Each may
 * be an ancestor of every page this Worker serves, above the app's own page:
 * `frame-ancestors` names every ancestor, so without it a page the app frames is
 * blank inside Deck. Never an app origin: not a message origin of any shell or
 * door, not in their `data-porthole-hosts`. Exact https origins only (no
 * `app://raft`, no wildcard or path), none an app origin, in order, without
 * repeats. Empty or unset: none. Throws on any bad entry, so a mistyped list
 * fails closed (the content domain is a 503) rather than framing for fewer or
 * other origins.
 */
export function framedByOriginsOf(value: string | undefined, appOrigins: readonly string[] = []): string[] {
  const origins: string[] = [];
  for (const entry of (value ?? "").split(/[\s,]+/)) {
    if (entry === "") continue;
    const url = URL.canParse(entry) ? new URL(entry) : null;
    if (url === null || !HTTPS_ORIGIN.test(entry) || url.origin !== entry)
      throw new Error(`FRAMED_BY_ORIGINS: ${JSON.stringify(entry)} is not an https origin (https://host[:port])`);
    if (appOrigins.includes(entry)) throw new Error(`FRAMED_BY_ORIGINS: ${entry} is an app origin already (APP_ORIGIN, EXTRA_APP_ORIGINS)`);
    if (!origins.includes(entry)) origins.push(entry);
  }
  return origins;
}

/** Who frames a page and who it talks to: the app origins (hosts), then the origins above the app (`framedBy`). */
export function frameOriginsOf(env: {
  readonly APP_ORIGIN?: string;
  readonly EXTRA_APP_ORIGINS?: string;
  readonly FRAMED_BY_ORIGINS?: string;
}): { readonly hostOrigins: string[]; readonly framedBy: string[] } {
  const hostOrigins = appOriginsOf(env.APP_ORIGIN!, env.EXTRA_APP_ORIGINS);
  return { hostOrigins, framedBy: framedByOriginsOf(env.FRAMED_BY_ORIGINS, hostOrigins) };
}
