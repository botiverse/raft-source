// Object windows (#337): open a platform object in a window of its own in Raft
// Desktop (objectWindowStore.ts). The public entry, for core and for an app's
// kind (Artifacts' mini viewer is the first): register a kind, open and close
// its windows, read the window a component is drawn in. ObjectWindowsHost is
// mounted once by the layout.

export {
  MAX_OBJECT_WINDOWS,
  canOpenObjectWindows,
  closeAllObjectWindows,
  closeObjectWindow,
  focusedObjectWindow,
  openObjectWindow,
  openObjectWindowInMain,
  registerObjectWindowKind,
  reloadObjectWindow,
  setObjectWindowTitle,
} from "./objectWindowStore";
export type { ObjectWindowKind, ObjectWindowRender, ObjectWindowRenderProps, OpenObjectWindowOptions } from "./objectWindowStore";
export { useObjectWindow } from "./objectWindowContext";
export type { ObjectWindowContextValue } from "./objectWindowContext";
export { raiseMainWindow } from "./raiseMainWindow";
export { openInSystemBrowser } from "./systemBrowser";
export { ObjectWindowsHost } from "./ObjectWindowsHost";
