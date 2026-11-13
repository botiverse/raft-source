import { requestFocus } from "./focusRequest";

type InputGetter = () => HTMLInputElement | null;

// The mounted search page's field, while there is one.
let mountedSearchInput: InputGetter | null = null;

/** The search page registers its field while mounted; call the returned function as it unmounts. */
export function registerMountedSearchInput(getInput: InputGetter): () => void {
  mountedSearchInput = getInput;
  return () => {
    if (mountedSearchInput === getInput) mountedSearchInput = null;
  };
}

/** ⌘K on the search page: the person's own command, so it takes focus from wherever it is (not from an open dialog). */
export function focusMountedSearch(): void {
  requestFocus(() => mountedSearchInput?.(), { reason: "user", onFocused: (input) => input.select() });
}

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
