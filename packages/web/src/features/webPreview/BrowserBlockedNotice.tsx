import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Info } from "lucide-react";
import { EXTERNAL_LINK_SCHEMES } from "@botiverse/raft-shared";
import type { DesktopWebPreviewBlocked } from "@botiverse/raft-shared";
import { Banner, BannerAction, BannerClose, BannerDescription, Button } from "@botiverse/raft-ui";

import { mediaMessageId } from "./browserSitePermissions";
import { useBrowserTabsStore } from "./browserTabsStore";
import type { BrowserTab } from "./browserTabsStore";
import { blockedAddressParts } from "./webPreviewAddress";
import { openWebPreviewInNewTab } from "./webPreviewStore";

/** The scheme of a refused link, for the notice's words ("mailto"), or "" where it has none. */
function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * What the tab's page asked for and the built-in browser refused, said on the
 * tab (#proj-workspace:#293: a page-initiated action is never dropped without
 * a word), with what the person can do instead:
 * - a Raft page: Open in Raft (the app's own way for its pages: in the app
 *   where it is one of its routes, else the system browser);
 * - Raft's sign-in for another site, and a window with no address: Open in
 *   browser, for the page the tab shows (it works there);
 * - another application's link: Open link, where Raft hands that scheme out
 *   at all (the shared allowlist); else the words alone;
 * - a download (the built-in browser saves no file: the shell handed its
 *   address to the system browser): says so, with the file's name, and Open
 *   in browser opens the address again (a download the browser did not
 *   start, or that needs this tab's sign-in, which the system browser lacks);
 * - the microphone or the camera the person allowed the site, refused Raft
 *   by the system (`media-system`, macOS): where to turn it on;
 * - no page at all (`storage`: the shell could not clear the site data the
 *   account before left, so it makes no page): Open in browser, for the
 *   address the tab would show.
 * Where the button opens an address the page chose (a Raft page, another
 * application's link), the notice shows that address, as text, with the whole
 * of it on hover: these are Raft's own words and button, so the person must
 * see where the page is sending them before pressing (Tenny, PR #14758).
 * Shown until the tab's next navigation or until it is put away.
 */
export function BrowserBlockedNotice({ conversationId, tab, blocked }: { conversationId: string; tab: BrowserTab; blocked: DesktopWebPreviewBlocked }) {
  const { formatMessage } = useIntl();
  const dismissBlocked = useBrowserTabsStore((s) => s.dismissBlocked);
  const dismiss = useCallback(() => dismissBlocked(conversationId, tab.id), [conversationId, dismissBlocked, tab.id]);
  const scheme = schemeOf(blocked.url);
  const pageUrl = tab.url;
  const address = blocked.reason === "raft" || blocked.reason === "scheme" ? blockedAddressParts(blocked.url) : null;
  const openBlocked = useCallback(() => {
    openWebPreviewInNewTab(blocked.url);
    dismiss();
  }, [blocked.url, dismiss]);
  const openPage = useCallback(() => {
    if (pageUrl) openWebPreviewInNewTab(pageUrl);
    dismiss();
  }, [dismiss, pageUrl]);
  const words = blocked.reason === "raft"
    ? formatMessage({ id: "webPreview.blocked.raft" })
    : blocked.reason === "raft-sign-in"
      ? formatMessage({ id: "webPreview.blocked.raftSignIn" })
      : blocked.reason === "scheme"
        ? formatMessage({ id: "webPreview.blocked.scheme" }, { scheme })
        : blocked.reason === "storage"
          ? formatMessage({ id: "webPreview.blocked.storage" })
          : blocked.reason === "media-system"
            ? formatMessage({ id: mediaMessageId("webPreview.blocked.mediaSystem", blocked.media ?? []) })
          : blocked.reason === "download"
            ? (blocked.file ? formatMessage({ id: "webPreview.blocked.download" }, { file: blocked.file }) : formatMessage({ id: "webPreview.blocked.downloadNoName" }))
          : formatMessage({ id: "webPreview.blocked.popup" });
  const action = blocked.reason === "raft"
    ? { label: formatMessage({ id: "webPreview.blocked.openInRaft" }), run: openBlocked }
    : blocked.reason === "download"
      ? { label: formatMessage({ id: "webPreview.openInBrowser" }), run: openBlocked }
    : blocked.reason === "scheme"
      ? (EXTERNAL_LINK_SCHEMES.includes(scheme) ? { label: formatMessage({ id: "message.messageItem.openLink" }), run: openBlocked } : null)
      : pageUrl ? { label: formatMessage({ id: "webPreview.openInBrowser" }), run: openPage } : null;
  return (
    <div className="shrink-0 border-b border-line-seam bg-layer-canvas px-(--column-margin) py-2">
      <Banner status="info" size="sm" role="status" data-testid="web-preview-blocked" data-reason={blocked.reason}>
        <Info aria-hidden />
        <BannerDescription>
          <span data-testid="web-preview-blocked-text">{words}</span>
          {address ? (
            <span className="block break-all" title={address.full} data-testid="web-preview-blocked-address">
              <span className="font-bold text-foreground">{address.lead}</span>
              <span className="text-foreground-muted">{address.rest}</span>
            </span>
          ) : null}
        </BannerDescription>
        {action ? (
          <BannerAction>
            <Button type="button" variant="outline" size="md" onClick={action.run} data-testid="web-preview-blocked-action">
              {action.label}
            </Button>
          </BannerAction>
        ) : null}
        <BannerClose aria-label={formatMessage({ id: "webPreview.close" })} onClick={dismiss} data-testid="web-preview-blocked-dismiss" />
      </Banner>
    </div>
  );
}
