import { lazyPanel } from "../boot/deferredUi";

// The public page's settings and release notes. Lazy like the member layout's:
// they are most of the settings code, and the public page is in the app's
// startup bundle. A failed download shows Try again in their place (lazyPanel).
// Here, not in PublicServerPage, which is at its module-shape line cap.
export const ReleaseNotesPanel = lazyPanel(() => import("../components/settings/ReleaseNotesPanel"));
export const SettingsPanel = lazyPanel(() => import("../components/settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
