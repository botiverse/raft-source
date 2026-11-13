import { useIntl } from "react-intl";
import {
  dismissWebVersionPrompt,
  reloadOntoPublishedRelease,
  useWebVersionPromptStore,
} from "../../utils/webVersionCheck";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { DESKTOP_SHELL_QUERY } from "../layout/desktopShell";
import { FloatingUpdateBanner } from "./FloatingUpdateBanner";

// A newer Web release is published and this tab has not reloaded itself
// yet, at a safe moment (utils/webVersionCheck). At desktop width the top
// bar's Update button is the prompt (WebUpdateButton); this banner is the
// prompt on a phone, which has no such bar, and on a page without the bar
// (sign-in, public pages, the server picker), so the notice is never lost.
// A release that has waited 24 hours without the tab reloading (always in
// front and in use, so never a safe moment to reload itself) shows it at
// desktop width too, beside the bar's button, once per release: its Dismiss
// puts this banner away on the device and leaves the button.
//
// Its action is Update, the top bar button's word; it reloads. Its look and
// place: FloatingUpdateBanner.
// Never both it and the stale-build strip: while that shows, its Refresh
// already loads the new release.

export function NewWebVersionBanner({ onReload = reloadOntoPublishedRelease }: { onReload?: () => void }) {
  const release = useWebVersionPromptStore((state) => state.release);
  const chunkStripShown = useWebVersionPromptStore((state) => state.chunkStripShown);
  const overdue = useWebVersionPromptStore((state) => state.overdue);
  const inTopBar = useWebVersionPromptStore((state) => state.topBarSlots > 0);
  // Below the shell's desktop breakpoint the bar is not shown (or hidden by the
  // stylesheet, `max-md:`, while the boot frame renders it), so its button
  // never counts there: the exact complement of where the bar shows.
  const desktopShell = useMediaQuery(DESKTOP_SHELL_QUERY, true);
  const besideButton = inTopBar && desktopShell;
  if (!release || chunkStripShown || (besideButton && !overdue)) return null;
  return <PlacedBanner onReload={onReload} besideButton={besideButton} />;
}

function PlacedBanner({ onReload, besideButton }: { onReload: () => void; besideButton: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <FloatingUpdateBanner
      message={formatMessage({ id: "app.update.newVersionAvailable" })}
      actionLabel={formatMessage({ id: "app.update.updateButton" })}
      onAction={onReload}
      onDismiss={besideButton ? dismissBesideButton : dismissPrompt}
    />
  );
}

// Beside the bar's button (the 24-hour banner): the banner goes, the button stays.
const dismissBesideButton = () => dismissWebVersionPrompt({ keepButton: true });
const dismissPrompt = () => dismissWebVersionPrompt();
