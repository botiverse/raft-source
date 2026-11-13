import { PanelHeading, PanelTitle, TextLink } from "@botiverse/raft-ui";
import { ChevronRight } from "lucide-react";
import { useIntl } from "react-intl";
import { Link } from "react-router-dom";

/**
 * The header title of a Settings page opened from a row inside a tab
 * (Account › Delete Account). On desktop it is "<tab> › <page>": the tab name
 * muted and linking back, the page name current (artin, 2026-11-04,
 * #triage:d10ace06; raft-design navigation.md's one breadcrumb exception).
 * On a phone it stays a pushed page: the plain title, with the header's Back.
 *
 * raft-ui has no Breadcrumb (Raft has none elsewhere), so this is built from
 * raft-ui's TextLink (muted) and PanelTitle and kept inside the settings head.
 * The whole trail is set as the title (headline, bold, sans): the tab name
 * differs from the page name only by its muted colour, so the two read as one
 * title in the same type as every other page's (cindyz, 2026-11-06).
 */
export function SettingsSubPageTitle({ tabLabel, tabHref, title }: { tabLabel: string; tabHref: string; title: string }) {
  const { formatMessage } = useIntl();
  return (
    <>
      <PanelHeading className="md:hidden">
        <PanelTitle render={<h2>{title}</h2>} />
      </PanelHeading>
      <nav
        aria-label={formatMessage({ id: "settings.breadcrumb.label" })}
        className="hidden min-w-0 md:block"
        data-testid="settings-breadcrumb"
      >
        <ol className="flex min-w-0 items-center gap-1 font-sans text-headline">
          <li className="shrink-0">
            <TextLink render={<Link to={tabHref} />} className="font-bold" data-testid="settings-breadcrumb-tab">
              {tabLabel}
            </TextLink>
          </li>
          <li aria-hidden="true" className="flex shrink-0 text-foreground-muted">
            <ChevronRight className="size-[1em]" />
          </li>
          <li className="min-w-0">
            <PanelTitle render={<h2 aria-current="page">{title}</h2>} />
          </li>
        </ol>
      </nav>
    </>
  );
}
