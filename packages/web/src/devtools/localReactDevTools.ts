import { HIDE_LOCAL_DEV_TOOLS_EVENT } from "../components/dev/devOverlayEvents";

export const REACT_GRAB_TOOLBAR_STORAGE_KEY = "react-grab-toolbar-state";
export const REACT_SCAN_COLLAPSED_STORAGE_KEY = "react-scan-widget-collapsed-v1";
type Edge = "top" | "right" | "bottom" | "left";
interface ReactGrabToolbarState { edge: Edge; ratio: number; collapsed: boolean; enabled: boolean; defaultAction?: string; }
interface ReactGrabApi {
  getToolbarState(): ReactGrabToolbarState | null;
  setToolbarState(state: Partial<ReactGrabToolbarState>): void;
  setEnabled(enabled: boolean): void;
  onToolbarStateChange(callback: (state: ReactGrabToolbarState) => void): () => void;
}
interface ReactGrabModule { getGlobalApi(): ReactGrabApi | null; }
interface ReactScanControls { setOptions(options: { enabled?: boolean; showToolbar?: boolean }): unknown; }

const DEFAULT_REACT_GRAB_TOOLBAR_STATE: ReactGrabToolbarState = { edge: "right", ratio: 0.3, collapsed: true, enabled: false };
const DEFAULT_REACT_SCAN_COLLAPSED_STATE = { corner: "top-left", orientation: "horizontal" } as const;

export function seedLocalReactDevToolPlacementDefaults(storage: Pick<Storage, "getItem" | "setItem">) {
  let reactGrab = false;
  let reactScan = false;
  try {
    if (storage.getItem(REACT_GRAB_TOOLBAR_STORAGE_KEY) === null) { storage.setItem(REACT_GRAB_TOOLBAR_STORAGE_KEY, JSON.stringify(DEFAULT_REACT_GRAB_TOOLBAR_STATE)); reactGrab = true; }
    if (storage.getItem(REACT_SCAN_COLLAPSED_STORAGE_KEY) === null) { storage.setItem(REACT_SCAN_COLLAPSED_STORAGE_KEY, JSON.stringify(DEFAULT_REACT_SCAN_COLLAPSED_STATE)); reactScan = true; }
  } catch { /* Storage is optional for dev tooling. */ }
  return { reactGrab, reactScan };
}
function parseReactGrabToolbarState(value: string | null): ReactGrabToolbarState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const edge = Reflect.get(parsed, "edge"); const ratio = Reflect.get(parsed, "ratio"); const collapsed = Reflect.get(parsed, "collapsed"); const enabled = Reflect.get(parsed, "enabled"); const defaultAction = Reflect.get(parsed, "defaultAction");
    if (!(["top", "right", "bottom", "left"] as string[]).includes(String(edge)) || typeof ratio !== "number" || !Number.isFinite(ratio) || typeof collapsed !== "boolean" || typeof enabled !== "boolean" || (defaultAction !== undefined && typeof defaultAction !== "string")) return null;
    return { edge: edge as Edge, ratio: Math.min(1, Math.max(0, ratio)), collapsed, enabled, ...(defaultAction === undefined ? {} : { defaultAction }) };
  } catch { return null; }
}
function persistReactGrabToolbarState(storage: Pick<Storage, "setItem">, state: ReactGrabToolbarState) { try { storage.setItem(REACT_GRAB_TOOLBAR_STORAGE_KEY, JSON.stringify(state)); } catch { /* optional */ } }
export function hideLocalReactDevTools(reactScan: ReactScanControls, reactGrab: ReactGrabModule): void {
  reactScan.setOptions({ enabled: false, showToolbar: false });
  const api = reactGrab.getGlobalApi();
  api?.setToolbarState({ collapsed: true, enabled: false });
  api?.setEnabled(false);
}
export async function installLocalReactDevTools(): Promise<void> {
  const initiallyEnabled = import.meta.env.VITE_ENABLE_REACT_SCAN === "true";
  let storage: Storage | null = null;
  try { storage = window.localStorage; seedLocalReactDevToolPlacementDefaults(storage); } catch { /* optional */ }
  const [, { scan, setOptions }, reactGrab] = await Promise.all([import("./localReactDevTools.css"), import("react-scan"), import("react-grab")]);
  scan({ enabled: initiallyEnabled, showToolbar: true, safeArea: { top: 72, right: 16, bottom: 80, left: 16 } });
  const reactGrabApi = reactGrab.getGlobalApi();
  const persisted = parseReactGrabToolbarState(storage?.getItem(REACT_GRAB_TOOLBAR_STORAGE_KEY) ?? null);
  if (reactGrabApi && persisted) reactGrabApi.setToolbarState({ ...(reactGrabApi.getToolbarState() ?? {}), ...persisted });
  let hidingUntilReload = false;
  reactGrabApi?.onToolbarStateChange((state) => { if (!hidingUntilReload && storage) persistReactGrabToolbarState(storage, state); });
  const hideUntilReload = () => { hidingUntilReload = true; hideLocalReactDevTools({ setOptions }, reactGrab); };
  window.addEventListener(HIDE_LOCAL_DEV_TOOLS_EVENT, hideUntilReload);
  if (document.documentElement.dataset.raftDevToolsHidden === "true") hideUntilReload();
}
