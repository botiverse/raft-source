// What may leave the check Worker about a page (isolation condition 2,
// #proj-workspace:#130): the lease's `url` is the version's content ticket,
// good once within 60 s, and is never logged, never put in an error, never
// reported. Logs carry ids, codes and counts only (log.ts); the report
// carries the page's own words (console errors) and addresses (blocked
// resources) with the ticket taken out of them.
import { ARTIFACT_CHECK_TEXT_MAX_CHARS } from "@botiverse/raft-shared/src/artifactCheckContract";

/** Any `ticket=` query value, encoded or not. */
const TICKET_PARAM = /([?&]ticket=)[^&#\s"'<>]*/gi;
/** A Porthole sealed files address segment (`/__porthole/f/<sealed>/`): a capability, collapsed. */
const SEALED_SEGMENT = /\/__porthole\/f\/[A-Za-z0-9_-]+\//g;
/** Any absolute URL (a scheme and `//`). */
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** A lone surrogate: JSON escapes it as six bytes, and the server's cut counts code points. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The ticket's value as it appears in `ticketUrl`'s query, raw and decoded (empty strings dropped). */
function ticketValuesOf(ticketUrl: string): string[] {
  const values = new Set<string>();
  const raw = /[?&]ticket=([^&#]*)/i.exec(ticketUrl)?.[1];
  if (raw) values.add(raw);
  if (URL.canParse(ticketUrl)) {
    const decoded = new URL(ticketUrl).searchParams.get("ticket");
    if (decoded) values.add(decoded);
  }
  return [...values];
}

/** `text` with the ticket taken out: the ticket URL, any `ticket=` value and the ticket's value itself. */
export function withoutTicket(text: string, ticketUrl: string): string {
  let out = ticketUrl ? text.split(ticketUrl).join(ticketPlaceholderOf(ticketUrl)) : text;
  // A real ticket is long; a short value would take out ordinary words with it.
  for (const value of ticketValuesOf(ticketUrl)) if (value.length >= 16) out = out.split(value).join("[ticket]");
  return out.replace(TICKET_PARAM, "$1[ticket]").replace(SEALED_SEGMENT, "/__porthole/f/…/");
}

/** What stands in for the ticket URL: its origin and path, no query. */
function ticketPlaceholderOf(ticketUrl: string): string {
  if (!URL.canParse(ticketUrl)) return "[ticket url]";
  const url = new URL(ticketUrl);
  return `${url.origin}${url.pathname}`;
}

/** Cut to `max` code points, control characters as spaces, no lone surrogate (the server's keptText, and JSON-safe). */
export function cutText(text: string, max = ARTIFACT_CHECK_TEXT_MAX_CHARS): string {
  return [...text.replace(CONTROL, " ").replace(LONE_SURROGATE, "�")].slice(0, max).join("");
}

/** A page's own words for the report (a console error's message): no ticket, cut. */
export function reportText(text: string, ticketUrl: string): string {
  return cutText(withoutTicket(text, ticketUrl));
}

/**
 * An address for the report (a console error's source, a blocked resource):
 * an http(s) URL as its origin and path (no query or fragment: neither a
 * ticket nor what a page sends out in one), a sealed segment collapsed; any
 * other scheme by its scheme alone (`data:`, `blob:`, `javascript:`).
 */
export function reportUrl(url: string, ticketUrl: string): string {
  if (!URL.canParse(url)) return cutText(withoutTicket(url, ticketUrl).split(/[?#]/)[0] ?? "");
  const parsed = new URL(url);
  const address = parsed.protocol === "http:" || parsed.protocol === "https:" ? `${parsed.origin}${parsed.pathname}` : parsed.protocol;
  return cutText(withoutTicket(address, ticketUrl));
}

/** For a log line: no URL at all, no ticket (log.ts runs every string field through this). */
export function forLog(text: string): string {
  return cutText(text.replace(ANY_URL, "[url]").replace(TICKET_PARAM, "$1[ticket]"), 120);
}
