import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../i18n/locale";
import type { Locale } from "../i18n/locale";
import { loadLocaleMessages, mergedMessages } from "../i18n/messages";
import { PendingServerLayout } from "../components/layout/PendingServerLayout";
import { ArtifactLinkLoading } from "../apps/artifacts";

/**
 * The boot shell for index.html (scripts/bootShellPlugin.ts): the same
 * PendingServerLayout React renders while a server loads, as static markup.
 * Two frames: the desktop one at a conversation (shown by default; the
 * stylesheet gives a phone its conversation column), and a phone's Home at a
 * server's root (`data-boot-frame="phone-home"`, shown instead under
 * `html.boot-home` on a phone). And a canonical Artifact link's frame
 * (`data-boot-frame="artifact"`, shown instead under `html.boot-artifact`):
 * the page's loading splash with "Loading Artifact" (ArtifactLinkLoading,
 * static: its icon and line held hidden for the first second by the shell's
 * CSS) once per display locale,
 * the boot script's `data-boot-locale` choosing which shows. Run at build time
 * only, in Node with a DOM shim.
 */
const SHELL_ENTRY = ["/s/_/channel/_"];
const PHONE_HOME_ENTRY = ["/s/_"];

function frame(entries: string[], layout: ReactElement): ReactElement {
  return (
    <MemoryRouter initialEntries={entries}>
      <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={mergedMessages(DEFAULT_LOCALE)}>
        {layout}
      </IntlProvider>
    </MemoryRouter>
  );
}

/** Each locale's words as the app shows them once its catalog is in (the same loader; English for an id it lacks). */
function artifactLinkFrame(): string {
  return SUPPORTED_LOCALES.map((locale: Locale) => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={mergedMessages(locale)}>
        <ArtifactLinkLoading prerender />
      </IntlProvider>,
    );
    return `<div data-boot-locale="${locale}" class="contents">${markup}</div>`;
  }).join("");
}

export async function renderBootShell(): Promise<string> {
  // The build has every catalog, not only the ones a reader has loaded.
  await Promise.all(SUPPORTED_LOCALES.map(loadLocaleMessages));
  return renderToStaticMarkup(frame(SHELL_ENTRY, <PendingServerLayout prerender />))
    + `<div data-boot-frame="phone-home" class="contents">${renderToStaticMarkup(frame(PHONE_HOME_ENTRY, <PendingServerLayout prerender="phone-home" />))}</div>`
    + `<div data-boot-frame="artifact" class="contents">${artifactLinkFrame()}</div>`;
}
