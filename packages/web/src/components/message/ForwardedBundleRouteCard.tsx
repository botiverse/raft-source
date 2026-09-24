import { useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import Button from "../ui/Button";
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

  const openDetail = () => {
    if (!window.matchMedia("(max-width: 767px)").matches) return false;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("forward", messageId);
      return next;
    });
    return true;
  };

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
          className="fixed bottom-0 left-0 right-0 top-0 z-[70] flex flex-col bg-white md:hidden"
          data-testid="forwarded-bundle-detail-page"
          aria-label={formatMessage({ id: "message.forwardedBundle.detailTitle" })}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b-2 border-black px-3">
            <Button type="button" shape="icon" tone="white" onClick={onBack} aria-label={formatMessage({ id: "message.forwardedBundle.backToConversation" })}>
              <ArrowLeft size={16} />
            </Button>
            <h1 className="text-sm font-bold">{formatMessage({ id: "message.forwardedBundle.detailTitle" })}</h1>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto p-3">
            <ForwardedBundleCard
              metadata={metadata}
              onOpenSource={onOpenSource}
              onOpenAttachment={onOpenAttachment}
              forceExpanded
            />
          </main>
        </section>,
        document.body,
      )}
    </>
  );
}
