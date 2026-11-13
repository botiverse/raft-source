export function getSearchEntry(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const searchEntry = (state as { searchEntry?: unknown }).searchEntry;
  return typeof searchEntry === "string" ? searchEntry : null;
}

export function getValidSearchSource(state: unknown, serverSlug: string | undefined): string | null {
  if (!serverSlug || !state || typeof state !== "object") return null;
  const searchFrom = (state as { searchFrom?: unknown }).searchFrom;
  if (typeof searchFrom !== "string") return null;
  const serverBase = `/s/${serverSlug}`;
  const searchPath = `${serverBase}/search`;
  if (
    !(searchFrom === serverBase || searchFrom.startsWith(`${serverBase}/`))
    || searchFrom === searchPath
    || searchFrom.startsWith(`${searchPath}?`)
    || searchFrom.startsWith(`${searchPath}#`)
    || searchFrom.startsWith(`${searchPath}/`)
  ) {
    return null;
  }
  return searchFrom;
}

export function getSearchShortcutSource(
  state: unknown,
  serverSlug: string | undefined,
): string | null {
  if (getSearchEntry(state) === "rail") return null;
  return getValidSearchSource(state, serverSlug);
}
