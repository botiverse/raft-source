import type { ArtifactFile } from "@botiverse/raft-shared";

/**
 * A framed page's link to a file of its own set that isn't a page (#proj-workspace:#256), e.g.
 * `<a href="./pic.png">`. Porthole opens a set's pages in the frame and stops every other
 * navigation (P084); the shell then tells the host where it went (`porthole/navigation-blocked`,
 * P080), the address resolved against the page that linked and with the version's files' address
 * written as `./`, so `./docs/pic.png` is the set's `docs/pic.png` whatever page linked to it.
 *
 * The address is the content's word (untrusted; the content may also send the notice itself, with
 * any address): it is only ever looked up in the mounted version's file list, never fetched,
 * opened or navigated to. A name of a file of the list, or nothing.
 */

// Where a relative address is resolved: a reserved name (RFC 2606), never reached. Under a folder
// of its own, so a `../` that climbs out of the set is seen.
const SET_ROOT = "https://set.invalid/set/";
const SET_ORIGIN = new URL(SET_ROOT).origin;
const SET_PATH = new URL(SET_ROOT).pathname;

/** At most what the shell sends of an address. */
const MAX_URL_LENGTH = 4096;

/** A page by Porthole's rule (P084): a folder, no extension, `.html` or `.htm`. Those open in the frame. */
function isSetPage(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name === "" || !name.includes(".") || name.endsWith(".html") || name.endsWith(".htm");
}

/**
 * The path of the mounted version's file a blocked navigation's `url` names, when it is one of
 * `files` and not a page; else null. Relative to the set (`./`, `../` and `.` normalised, the
 * query and fragment dropped, each segment percent-decoded); anything with a scheme, a host, a
 * leading `/`, a `../` out of the set, or a segment that doesn't decode (or decodes to a `/`) is
 * no file of the set.
 */
export function blockedSetFile(url: unknown, files: readonly Pick<ArtifactFile, "path">[]): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  let resolved: URL;
  try {
    resolved = new URL(url, SET_ROOT);
  } catch {
    return null;
  }
  if (resolved.origin !== SET_ORIGIN || !resolved.pathname.startsWith(SET_PATH)) return null;
  let names: string[];
  try {
    names = resolved.pathname.slice(SET_PATH.length).split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (names.some((name) => name.includes("/"))) return null;
  const path = names.join("/");
  if (isSetPage(path)) return null;
  return files.some((file) => file.path === path) ? path : null;
}

/**
 * Whether a content error is Porthole's word on the blocked navigation to `url` (P080: it names
 * the address without its query or fragment), so a link the viewer answered raises no error.
 */
export function blockedNoticeNames(message: string, url: string): boolean {
  const address = url.split(/[?#]/u)[0] ?? "";
  return address !== "" && message.includes(address);
}

/**
 * Whether the page's word may open a view now: the reader is in the frame (Raft's focus inside its
 * box, as after a click or Enter on the page's link) or nowhere in Raft's own controls. Never while
 * they work elsewhere in Raft (writing a comment, in a menu): a notice the page sent then is not
 * their click, and the view it would open would take the place of what they are using.
 */
export function readerInFrame(frameRoot: Element | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (frameRoot !== null && frameRoot.contains(active));
}
