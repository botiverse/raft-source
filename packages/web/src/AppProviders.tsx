import type { ComponentType, ReactNode } from "react";
import { TooltipProvider } from "@botiverse/raft-ui";
import { BrowserRouter } from "react-router-dom";
import { AppThemeProvider } from "./theme/AppThemeProvider";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { IntlProviderWrapper } from "./i18n/IntlProviderWrapper";
import LocalizedToastProvider from "./components/LocalizedToastProvider";
import { ForwardToastProvider } from "./components/message/ForwardToastProvider";

/**
 * The application's root provider composition — the ONE place that defines
 * which contexts every screen under <App/> may rely on, and in what order.
 *
 * Every host that mounts the web app (the web entry, the desktop shell, test
 * harnesses) must render through this component instead of re-listing the
 * providers by hand. Desktop 0.1.29 (2026-09-24) shipped crashing after login
 * because its entry had hand-copied this tree and missed a provider a later web
 * change made mandatory; nothing in either CI noticed. Keeping the composition
 * here means a new required context reaches every host on its next build.
 *
 * Contract for adding a provider: add it here, and add a probe for the hook it
 * backs to tests/appProviders.behavior.test.tsx (removed in the 2026-11 web DOM test prune) so hosts are proven complete.
 *
 * Hosts customise only through the props below — never by wrapping a subset:
 * - `router`: the react-router router (web + desktop: BrowserRouter; tests:
 *   MemoryRouter).
 * - `insideRouter`: elements that must live under the router but above the
 *   locale/intl layer (web: the service-worker navigation bridge).
 */
export interface AppProvidersProps {
  children: ReactNode;
  router?: ComponentType<{ children: ReactNode }>;
  insideRouter?: ReactNode;
}

export const TOOLTIP_DELAY_MS = 600;

export function AppProviders({ children, router: Router = BrowserRouter, insideRouter = null }: AppProvidersProps) {
  return (
    <AppThemeProvider>
      <TooltipProvider delay={TOOLTIP_DELAY_MS}>
        <Router>
          {insideRouter}
          <LocaleProvider>
            <IntlProviderWrapper>
              <LocalizedToastProvider>
                <ForwardToastProvider>
                  {children}
                </ForwardToastProvider>
              </LocalizedToastProvider>
            </IntlProviderWrapper>
          </LocaleProvider>
        </Router>
      </TooltipProvider>
    </AppThemeProvider>
  );
}

export default AppProviders;
