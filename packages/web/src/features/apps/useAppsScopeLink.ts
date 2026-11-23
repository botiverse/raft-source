import { useEffect, useEffectEvent, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ConnectedAppsTab } from "../../components/settings/SettingsSegmentedControls";
import { APPS_SCOPE_PARAM, appsScopeFromTab } from "./appsScope";
import { hasInstalledAppLink } from "./useAppBotLink";

/**
 * The scope a link names (`?tab=`, `appsScope.ts`) is used once: applied when
 * it shows up in the address, then removed from it with one replace, the
 * other parameters kept. So a later address change (a profile opening adds
 * `?profile=`) doesn't put the page back on the link's scope, and neither do
 * Refresh and Back.
 *
 * Beside `?app_bot=` or `?installed_app=` it stays until `useAppBotLink`
 * handles those (once the list is read) and leaves with them in that hook's
 * one replace: two replaces from the same address would each put back what
 * the other removed. While it waits it is not applied a second time.
 */
export function useAppsScopeLink(apply: (scope: ConnectedAppsTab) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  // The value already applied and still in the address.
  const applied = useRef<string | null>(null);
  const consume = useEffectEvent(() => {
    const params = new URLSearchParams(location.search);
    const requested = params.get(APPS_SCOPE_PARAM);
    if (requested === null) {
      applied.current = null;
      return;
    }
    if (applied.current !== requested) {
      applied.current = requested;
      const scope = appsScopeFromTab(requested);
      if (scope) apply(scope);
    }
    if (hasInstalledAppLink(params)) return;
    params.delete(APPS_SCOPE_PARAM);
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true });
  });
  useEffect(() => {
    consume();
  }, [location.search]);
}
