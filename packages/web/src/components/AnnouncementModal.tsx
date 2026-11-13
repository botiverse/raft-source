import { createPortal } from "react-dom";
import AnnouncementSidebarCard, { announcementInAppPath, announcementServerPath, announcementMarkdownComponents, isAnnouncementExternalHref } from "./AnnouncementSidebarCard";
import AnnouncementCardPicture from "./AnnouncementCardPicture";
import LeavingRaftMark, { useLeavingRaftLabel } from "./ui/LeavingRaftMark";
import { dismissLayerProps } from "./ui/dismissLayer";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import type { DialogProps } from "@botiverse/raft-ui";
import { toast } from "@botiverse/raft-ui";
import { AnnouncementDialog, AnnouncementDialogAction, AnnouncementDialogBody, AnnouncementDialogClose, AnnouncementDialogContent, AnnouncementDialogFooter, AnnouncementDialogHeader, AnnouncementDialogLabel, AnnouncementDialogPicture, AnnouncementDialogText, AnnouncementDialogTitle } from "@botiverse/raft-ui/wip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import type { Announcement } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { useAnnouncementStore } from "../store/announcementStore";
import { useServerStore } from "../store/serverStore";
import { claimAnnouncementShown } from "../analytics/announcements";
import { trackEvent } from "../analytics/track";
import { shouldAutoDismissSlockdevAnnouncement } from "../utils/devMode";
import { useMediaQuery } from "../hooks/effectPrimitives";

type AnnouncementAction = "primary" | "secondary" | "close" | "outside" | "escape" | "next";

const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly];
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** Fills the dialog's aspect-video picture slot, like the img it replaces. */
const MODAL_PICTURE_BOX_CLASS = "relative h-full w-full";

export default function AnnouncementModal({ suppressed = false, preferSidebar = false, sidebarContainer }: { suppressed?: boolean; preferSidebar?: boolean; sidebarContainer?: HTMLElement | null }) {
  const pending = useAnnouncementStore((state) => state.pending);
  const stackTotal = useAnnouncementStore((state) => state.stackTotal);
  const writeFailedIds = useAnnouncementStore((state) => state.writeFailedIds);
  const { formatMessage } = useIntl();
  const notifiedRef = useRef<Set<string>>(new Set());

  // A failed read-complete write is invisible by construction: the modal has
  // already closed and the queue has already advanced past the row, so nothing
  // else in the UI would reveal that it was never recorded. Raised here rather
  // than inside the store so the copy stays translatable. This component is
  // mounted for the whole session (it returns null when idle), so the toast
  // still fires for a row whose modal has gone.
  useEffect(() => {
    for (const id of writeFailedIds) {
      if (notifiedRef.current.has(id)) continue;
      notifiedRef.current.add(id);
      toast.error(formatMessage({ id: "common.announcement.saveFailed" }));
    }
  }, [writeFailedIds, formatMessage]);

  const serverId = useServerStore((state) => state.current?.id);
  const candidate = pending[0];
  const { pathname } = useLocation();
  // Sidebar-style announcements only appear in Home/chat, on every device.
  // Keep the pending row intact elsewhere so returning to chat can show it.
  const chatPage = ["/s/:slug", "/s/:slug/channel/:id", "/s/:slug/dm/:id", "/s/:slug/assistant"]
    .some((path) => matchPath(path, pathname) !== null);
  const deferSidebar = candidate?.displayMode === "sidebar" && !chatPage;
  const current = suppressed || deferSidebar || (candidate?.deliveryScope?.type === "server" && candidate.deliveryScope.serverId !== serverId) ? undefined : candidate;
  if (!current || current.pages.length === 0) return null;
  const stackSize = Math.max(stackTotal, pending.length);
  return <AnnouncementModalContent key={`${current.id}:${current.deliveryVersion ?? 1}`} current={current} sidebar={current.displayMode === "sidebar" && preferSidebar} sidebarContainer={sidebarContainer} position={stackSize - pending.length + 1} total={stackSize} />;
}

function AnnouncementModalContent({ current, sidebar, sidebarContainer, position, total }: { current: Announcement; sidebar: boolean; sidebarContainer?: HTMLElement | null; position: number; total: number }) {
  const { formatMessage } = useIntl();
  const opensInNewTab = useLeavingRaftLabel();
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const markdownComponents = useMemo(() => announcementMarkdownComponents(opensInNewTab), [opensInNewTab]);
  const navigate = useNavigate();
  const dismiss = useAnnouncementStore((state) => state.dismiss);
  const advance = useAnnouncementStore((state) => state.advance);
  const activated = useRef(false);
  const serverId = useServerStore((state) => state.current?.id);
  const serverSlug = useServerStore((state) => state.current?.slug);
  useEffect(() => {
    const shown = () => {
      if (document.visibilityState !== "visible" || !serverId || (sidebar && !sidebarContainer)) return;
      if (!claimAnnouncementShown(current.id, current.deliveryVersion ?? 1)) return;
      trackEvent("announcement_shown", { announcement_id: current.id, delivery_version: current.deliveryVersion ?? 1 }, { serverId });
    };
    shown();
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [current.id, current.deliveryVersion, serverId, sidebar, sidebarContainer]);
  // Sidebar cards (task #26): moving on in place (Got it / Next, or a CTA that
  // opens a new tab) records this card and shows the next one of the entry.
  // Close, or a CTA that navigates inside Raft, ends the stack for this entry;
  // cards not reached stay unread and return on the next entry.
  const close = useCallback((action?: AnnouncementAction, next = false) => {
    if (activated.current) return;
    activated.current = true;
    if (action) trackEvent("announcement_interacted", {
      announcement_id: current.id, delivery_version: current.deliveryVersion ?? 1,
      action, has_cta: Boolean(current.cta),
    }, { serverId });
    void (next && sidebar ? advance(current.id) : dismiss(current.id));
  }, [current.id, current.deliveryVersion, current.cta, dismiss, advance, sidebar, serverId]);
  // A sidebar card whose picture is pressed opens as the centred dialog (cindyz, #wg-announcement:1110917b);
  // closing that dialog puts the card back, unread. Its buttons act as the card's do.
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const onOpenChange = useCallback<NonNullable<DialogProps["onOpenChange"]>>((open, details) => {
    if (open) return;
    if (sidebar) {
      setExpanded(false);
      // The card comes back; focus returns to its picture, which opened the dialog.
      requestAnimationFrame(() => sidebarContainer?.querySelector<HTMLElement>('[data-testid="announcement-sidebar-picture-zoom"]')?.focus());
      return;
    }
    const action = details.reason === "outside-press" ? "outside"
      : details.reason === "escape-key" ? "escape"
      : details.reason === "close-press" ? "close" : undefined;
    close(action);
  }, [close, sidebar, sidebarContainer]);
  // On a sidebar stack, the acknowledgement button reads "Next" until the last card.
  const nextCard = sidebar && position < total;
  const acknowledge = useCallback(() => close(nextCard ? "next" : "secondary", true), [close, nextCard]);
  const closeSidebar = useCallback(() => close("close"), [close]);
  const activate = useCallback(() => {
    if (activated.current) return;
    const inApp = current.cta ? announcementInAppPath(current.cta.href) : null;
    close(!current.cta && nextCard ? "next" : "primary", inApp === null);
    // Open external links synchronously in the user gesture; persistence failure
    // still appears through the store's save-failed toast.
    if (!current.cta) return;
    if (inApp !== null) navigate(announcementServerPath(inApp, serverSlug));
    else window.open(current.cta.href, "_blank", "noopener,noreferrer");
  }, [current.cta, close, navigate, nextCard, serverSlug]);
  useEffect(() => {
    if (!shouldAutoDismissSlockdevAnnouncement(import.meta.env?.VITE_DEPLOYMENT_ENV)) return;
    const frame = requestAnimationFrame(() => close());
    return () => cancelAnimationFrame(frame);
  }, [close]);
  useEffect(() => {
    if (sidebar && !expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      // Let the focused control perform its own action (including secondary/close).
      if (event.target instanceof Element && event.target.closest('[data-testid="announcement-modal"] button, [data-testid="announcement-modal"] a')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activate();
    };
    // keydown-global-exempt: AnnouncementDialog owns initial focus; capture handles Enter before the background composer.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activate, close, current.cta, sidebar, expanded]);
  const gotIt = formatMessage({ id: "common.announcement.gotIt", defaultMessage: "Got It" });
  const dialog = <AnnouncementDialog open onOpenChange={onOpenChange}>
      <AnnouncementDialogContent {...dismissLayerProps} layer={1} data-testid="announcement-modal">
        <AnnouncementDialogBody>
          <AnnouncementDialogHeader>
            <AnnouncementDialogLabel>{current.label ?? formatMessage({ id: "common.announcement.whatsNew", defaultMessage: "What's new" })}</AnnouncementDialogLabel>
            <AnnouncementDialogClose aria-label={formatMessage({ id: "common.announcement.dismiss" })} />
          </AnnouncementDialogHeader>
          <AnnouncementDialogTitle data-testid="announcement-title">{current.title}</AnnouncementDialogTitle>
          {current.image && <AnnouncementDialogPicture className="aspect-video h-auto border-0 [&_img]:object-fill"><AnnouncementCardPicture src={`${RUNTIME_API_BASE.replace(/\/$/, "")}/announcements/images/${current.image.assetId}`} alt={current.image.alt} playing={!reducedMotion} boxClassName={MODAL_PICTURE_BOX_CLASS} testId="announcement-modal-picture" /></AnnouncementDialogPicture>}
          <AnnouncementDialogText data-testid="announcement-page-body">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{current.pages[0]?.body ?? ""}</ReactMarkdown>
          </AnnouncementDialogText>
        </AnnouncementDialogBody>
        {/* One button (cindyz, #proj-raft-ui:b16e2945): the call to action, or Got it when there is none. With an action, × already closes it, so a Got it beside the action would do what × does. The admin preview mirrors this. */}
        <AnnouncementDialogFooter>
          <AnnouncementDialogAction onClick={activate} data-testid="announcement-ok">
            {current.cta?.label ?? gotIt}
            {current.cta && isAnnouncementExternalHref(current.cta.href) ? <LeavingRaftMark data-icon="inline-end" /> : null}
          </AnnouncementDialogAction>
        </AnnouncementDialogFooter>
      </AnnouncementDialogContent>
    </AnnouncementDialog>;
  if (sidebar) {
    if (!sidebarContainer) return null;
    // While it is open as the dialog, the card steps aside: the same announcement is never shown twice.
    return <>{!expanded && createPortal(<div className="p-2"><AnnouncementSidebarCard content={current} imageUrl={current.image ? `${RUNTIME_API_BASE.replace(/\/$/, "")}/announcements/images/${current.image.assetId}` : undefined} defaultLabel={formatMessage({ id: "common.announcement.whatsNew" })} closeLabel={formatMessage({ id: "common.announcement.dismiss" })} gotItLabel={position < total ? formatMessage({ id: "common.announcement.nextCard" }) : gotIt} opensInNewTabLabel={opensInNewTab} zoomLabel={current.image ? formatMessage({ id: "common.announcement.openFull" }, { title: current.title }) : undefined} onZoomImage={current.image ? expand : undefined} position={position} total={total} positionText={formatMessage({ id: "common.announcement.positionShort" }, { index: position, total })} positionLabel={formatMessage({ id: "common.announcement.position" }, { index: position, total })} onClose={closeSidebar} onAction={activate} onAcknowledge={acknowledge} /></div>, sidebarContainer)}{expanded && dialog}</>;
  }
  return dialog;
}
