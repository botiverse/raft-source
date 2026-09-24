import type { ReactNode } from "react";
import { ThemeProvider, TooltipProvider } from "raft-ui";
import { BrowserRouter } from "react-router-dom";

import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

export function VisualTestingRoot({
  children,
  defaultTheme,
}: {
  children: ReactNode;
  defaultTheme: "brutal" | "elegant";
}) {
  return (
    <ThemeProvider defaultTheme={defaultTheme} defaultMode="light">
      <TooltipProvider>
        <BrowserRouter>
          <LocaleProvider>
            <IntlProviderWrapper>{children}</IntlProviderWrapper>
          </LocaleProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  );
}
