// True only inside the Raft Desktop (electron) shell, which the desktop preload
// marks with a `raftDesktop` global. Used for desktop-aware defaults in shared
// web code (kept dependency-free so stores can import it without cycles).
export function isElectronDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { raftDesktop?: { isDesktop?: boolean } }).raftDesktop?.isDesktop === true
  );
}
