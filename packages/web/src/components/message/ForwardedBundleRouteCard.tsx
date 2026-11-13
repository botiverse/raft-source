import { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { PanelAction, PanelHeader, ScrollArea } from "@botiverse/raft-ui";
import ForwardedBundleCard from "./ForwardedBundleCard";
import type {
  ForwardedBundleAttachmentSnapshot,
  ForwardedBundleItem,
  ForwardedBundleMetadata,
} from "./ForwardedBundleCard";

export function forwardDetailFallbackPath(
  location: Pick<Location, "pathname" | "search" | "hash">,
) {
  const params = new URLSearchParams(location.search);
  params.delete("forward");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export default function ForwardedBundleRouteCard({
  messageId,
  metadata,
  onOpenSource,
  onOpenAttachment,
}: {
  messageId: string;
  metadata: ForwardedBundleMetadata;
  onOpenSource?: (item: ForwardedBundleItem) => void;
  onOpenAttachment?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const { formatMessage } = useIntl();
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const location = useLocation();
  const fallbackPath = useMemo(() => forwardDetailFallbackPath(location), [location]);
  const onBack = useMobileBack(fallbackPath);
  const detailOpen = searchParams.get("forward") === messageId;

  const openDetail = useCallback(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) return false;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("forward", messageId);
      return next;
    });
    return true;
  }, [messageId, setSearchParams]);

  return (
    <>
      <ForwardedBundleCard
        metadata={metadata}
        onOpenSource={onOpenSource}
        onOpenAttachment={onOpenAttachment}
        onShowAll={openDetail}
      />
      {detailOpen && createPortal(
        <section
          className="fixed bottom-0 left-0 right-0 top-0 z-dialog flex flex-col bg-layer-canvas md:hidden"
          data-testid="forwarded-bundle-detail-page"
          aria-label={formatMessage({ id: "message.forwardedBundle.detailTitle" })}
        >
          {/* The phone NavBar is raft-ui's panel head (Back 3px from the
              edge, mirroring the last action). */}
          <PanelHeader render={<header />}>
            <PanelAction onClick={onBack} aria-label={formatMessage({ id: "message.forwardedBundle.backToConversation" })}>
              <ArrowLeft />
            </PanelAction>
            <h1 className="min-w-0 truncate text-headline text-foreground">{formatMessage({ id: "message.forwardedBundle.detailTitle" })}</h1>
          </PanelHeader>
          <ScrollArea
            render={<main />}
            aria-label={formatMessage({ id: "message.forwardedBundle.detailTitle" })}
            className="min-h-0 flex-1"
            contentClassName="p-3"
          >
            <ForwardedBundleCard
              metadata={metadata}
              onOpenSource={onOpenSource}
              onOpenAttachment={onOpenAttachment}
              forceExpanded
            />
          </ScrollArea>
        </section>,
        document.body,
      )}
    </>
  );
}
