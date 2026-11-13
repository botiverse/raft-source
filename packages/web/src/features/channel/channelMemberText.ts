/** Live roster filter for the members page search box — matches on the
 *  handle or the display name, case-insensitive (query pre-normalized). */
export function memberMatches(query: string, name: string, displayName: string | null): boolean {
  if (!query) return true;
  return (
    name.toLowerCase().includes(query)
    || (displayName ?? "").toLowerCase().includes(query)
  );
}

/** External (Slack) participant handle in its @ protocol form. */
export function handleLabel(handle: string): string {
  return `@${handle}`;
}
