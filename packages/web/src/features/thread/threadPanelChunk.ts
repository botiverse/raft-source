import { deferredModule } from "../../boot/deferredUi";

/**
 * The thread panel's code (ThreadPanel: the replies, their composer, the
 * header and outline), off the first download: a thread opens from a click,
 * so it is fetched in the background after the first screen (boot/deferredUi)
 * and is normally in before anyone opens one. Every surface renders it through
 * DeferredThreadPanel, so the module keeps a chunk of its own.
 */
export const loadThreadPanel = deferredModule(() => import("./ThreadPanel").then((module) => ({ default: module.ThreadPanel })));

/** main.tsx, at boot: an address with a thread open (`?thread=`) starts the panel's code with the first requests. */
export function preloadThreadPanelForLocation(location: Pick<Location, "search">): void {
  if (new URLSearchParams(location.search).has("thread")) void loadThreadPanel().catch(() => {});
}
