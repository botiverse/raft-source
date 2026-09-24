export const SEARCH_FOCUS_REQUEST_EVENT = "slock:search-focus-request";

export function routeGlobalSearchShortcut({
  pathname,
  searchPath,
  focusMountedSearch,
  navigateToSearch,
}: {
  pathname: string;
  searchPath: string;
  focusMountedSearch: () => void;
  navigateToSearch: () => void;
}): "focused" | "navigated" {
  if (pathname === searchPath || pathname.startsWith(`${searchPath}/`)) {
    focusMountedSearch();
    return "focused";
  }
  navigateToSearch();
  return "navigated";
}
