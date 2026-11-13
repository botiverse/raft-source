// Desktop width (≥768px, the md breakpoint) for tests of layouts that switch
// there, e.g. the ⌘K search overlay (search/searchOverlayLocation.ts). The
// desktop app's window is never narrower, so this is also "in the desktop app".
// Returns the restore.
export function stubDesktopWidth(): () => void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = previous;
  };
}
