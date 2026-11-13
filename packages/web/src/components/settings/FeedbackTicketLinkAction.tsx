import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { Link } from "lucide-react";
import { PanelAction, PanelActions } from "@botiverse/raft-ui";
import { feedbackTicketUrl } from "../../feedback/feedbackTicketLink";
import { useServerStore } from "../../store/serverStore";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { showToast } from "../toastBridge";
import Tooltip from "../ui/Tooltip";

// The Hands feedback SDK (@botiverse/hands-feedback-react 0.5.3) draws the
// ticket's header and takes no host actions for it, so Copy link is portalled
// into that header through a `display: contents` slot: first in the SDK's own
// action group (left of Close ticket) when it has one, else at the header's
// end wrapped in a PanelActions of its own (a closed or resolved ticket).
// Replace with an SDK header-actions slot once Hands offers one.
const SECTION_SELECTOR = "section.hands-feedback-detail";
const HEADER_SELECTOR = ".hands-feedback-header";

/** Puts the slot in the header; true when it joined the SDK's action group. */
function placeSlot(header: HTMLElement, slot: HTMLElement): boolean {
  const sdkGroup = Array.from(header.children).find(
    (child) => child !== slot && child.getAttribute("data-slot") === "panel-actions",
  );
  if (sdkGroup) {
    if (sdkGroup.firstChild !== slot) sdkGroup.insertBefore(slot, sdkGroup.firstChild);
    return true;
  }
  if (header.lastElementChild !== slot) header.appendChild(slot);
  return false;
}

/**
 * A `display: contents` node kept in the open ticket's SDK header (detached
 * until the header is drawn), and whether it sits in the SDK's action group.
 * Watches only the ticket's section and header, not the conversation.
 */
function useTicketHeaderSlot(rootRef: RefObject<HTMLElement | null>, ticketId: string) {
  const [slot] = useState(() => {
    const node = document.createElement("div");
    node.style.display = "contents";
    return node;
  });
  const [inSdkGroup, setInSdkGroup] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let section: Element | null = null;
    let header: HTMLElement | null = null;
    const observer = new MutationObserver(() => sync());
    function sync() {
      const nextSection = root!.querySelector(SECTION_SELECTOR);
      const nextHeader = nextSection?.querySelector<HTMLElement>(HEADER_SELECTOR) ?? null;
      if (nextSection !== section || nextHeader !== header) {
        section = nextSection;
        header = nextHeader;
        observer.disconnect();
        // Until the ticket's section exists, watch for it; then only it and its header.
        if (!section) observer.observe(root!, { childList: true, subtree: true });
        else {
          observer.observe(section, { childList: true });
          if (header) observer.observe(header, { childList: true });
        }
      }
      if (header) setInSdkGroup(placeSlot(header, slot));
    }
    sync();
    return () => {
      observer.disconnect();
      slot.remove();
    };
  }, [rootRef, slot, ticketId]);
  return { slot, inSdkGroup };
}

/** Copy link in an open feedback ticket's header: the ticket's absolute URL, with its App's `?platform=`. */
export function FeedbackTicketLinkAction({ rootRef, ticketId }: {
  rootRef: RefObject<HTMLElement | null>;
  ticketId: string;
}) {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((state) => state.current?.slug);
  const { slot, inSdkGroup } = useTicketHeaderSlot(rootRef, ticketId);
  const label = formatMessage({ id: "settings.about.feedbackCopyTicketLink" });
  const copyLink = useCallback(() => {
    const url = feedbackTicketUrl(serverSlug, ticketId);
    if (!url) return;
    void copyTextToClipboard(url, formatMessage).then(
      () => showToast({ title: formatMessage({ id: "settings.about.feedbackTicketLinkCopied" }), type: "success" }),
      () => showToast({ title: formatMessage({ id: "settings.about.feedbackTicketLinkCopyFailed" }), type: "error" }),
    );
  }, [formatMessage, serverSlug, ticketId]);

  if (!serverSlug) return null;
  const action = (
    <Tooltip content={label}>
      <PanelAction aria-label={label} onClick={copyLink} data-testid="settings-feedback-ticket-copy-link">
        <Link aria-hidden="true" />
      </PanelAction>
    </Tooltip>
  );
  return createPortal(inSdkGroup ? action : <PanelActions>{action}</PanelActions>, slot);
}
