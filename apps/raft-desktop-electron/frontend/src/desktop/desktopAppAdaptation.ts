// Marks the document as the Electron desktop shell so the desktop-only CSS in
// frontend/src/index.css (gated on html[data-raft-desktop-shell]) can adapt the
// reused web UI to feel native — draggable title bars, traffic-light inset,
// hidden-because-redundant rail affordances.
//
// This lives in the desktop app (not packages/web): the web/mobile bundle is
// shared and must stay free of desktop-only concerns. The desktop frontend calls
// it once, before first paint, from main.tsx.
export function applyDesktopAppAdaptation(
  targetDocument: Pick<Document, "documentElement"> = document,
): void {
  targetDocument.documentElement.dataset.raftDesktopShell = "electron";
}
