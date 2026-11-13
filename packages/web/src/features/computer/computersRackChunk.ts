import { deferredModule } from "../../boot/deferredUi";

/**
 * The Computers rack's code, off the first
 * download (boot/deferredUi): one load shared by the desktop overview
 * (MainLayout), the phone's Computers page (MobileComputersPanel) and the
 * boot's start for that route, so all of them wait on the same request.
 */
// Not importHandledLocally here: the panels that render it wrap their own wait
// (deferredPanel); this early start and the prefetch keep the app's recovery.
export const loadComputersRack = deferredModule(() =>
  Promise.all([import("./ComputersRackOverview"), import("./ComputersRackList"), import("./ComputersRackToolbar")]).then(([overview, list, toolbar]) => ({
    default: overview.ComputersRackOverview,
    ComputersRackList: list.ComputersRackList,
    ComputersRackToolbar: toolbar.ComputersRackToolbar,
  })),
);

const COMPUTERS_ROUTE = /^\/s\/[^/]+\/computers\/?$/;

/**
 * main.tsx, at boot: a page that opens on Computers (the native WebView lands
 * on the phone's) starts the rack's code with the entry's, instead of after
 * the page has rendered.
 */
export function preloadComputersRackForRoute(pathname: string): void {
  if (COMPUTERS_ROUTE.test(pathname)) void loadComputersRack().catch(() => {});
}
