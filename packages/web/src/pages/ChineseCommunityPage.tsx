import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { trackEvent } from "../analytics/posthog";
import {
  getChineseCommunityQrConfigUrl,
  isChineseCommunityQrExpired,
  normalizeChineseCommunityQrConfig,
} from "../utils/chineseCommunityQr";
import type { ChineseCommunityQrConfig } from "../utils/chineseCommunityQr";
import { useBrowserDocumentTitle } from "../utils/browserDocumentTitle";

type QrState =
  | { status: "loading" }
  | { status: "ready"; config: ChineseCommunityQrConfig }
  | { status: "missing" };

function qrUnavailableMessageId(status: QrState["status"], expired: boolean, imageLoadFailed: boolean) {
  if (status === "missing") return "pages.chineseCommunity.missingQr";
  if (expired) return "pages.chineseCommunity.expiredQr";
  if (imageLoadFailed) return "pages.chineseCommunity.unavailableQr";
  return "pages.chineseCommunity.missingQr";
}

export default function ChineseCommunityPage() {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<QrState>({ status: "loading" });
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const configUrl = useMemo(() => getChineseCommunityQrConfigUrl(), []);
  const from = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("from") || "direct";
  }, []);

  useBrowserDocumentTitle(formatMessage({ id: "pages.chineseCommunity.title" }));

  const loadConfig = async () => {
    setState({ status: "loading" });
    setFailedImageUrl(null);
    try {
      const response = await fetch(configUrl, { cache: "no-store" });
      if (!response.ok) {
        setState({ status: "missing" });
        return;
      }
      const config = normalizeChineseCommunityQrConfig(await response.json());
      setState(config ? { status: "ready", config } : { status: "missing" });
    } catch {
      setState({ status: "missing" });
    }
  };

  useEffect(() => {
    trackEvent("community_cn_qr_page_view", { from });
    void loadConfig();
    // `loadConfig` intentionally reads the memoized config URL only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configUrl, from]);

  const config = state.status === "ready" ? state.config : null;
  const expired = config ? isChineseCommunityQrExpired(config.expiresAt) : false;
  const imageLoadFailed = Boolean(config && failedImageUrl === config.imageUrl);
  const showQrImage = Boolean(config && !expired && !imageLoadFailed);
  const unavailableMessageId = qrUnavailableMessageId(state.status, expired, imageLoadFailed);

  return (
    <main className="h-dvh overflow-hidden bg-brutal-cream px-4 font-display text-black safe-top safe-bottom">
      <div className="mx-auto flex h-full w-full max-w-sm flex-col items-center justify-center gap-5 text-center">
        <h1 className="text-2xl font-black leading-tight sm:text-3xl">
          {formatMessage({ id: "pages.chineseCommunity.title" })}
        </h1>

        <section
          aria-label={formatMessage({ id: "pages.chineseCommunity.qrLabel" })}
          className="w-full max-w-[20rem] border-2 border-black bg-white p-3 shadow-brutal sm:p-4"
        >
          <div className="mx-auto grid aspect-square w-full place-items-center border-2 border-black bg-brutal-cream">
            {state.status === "loading" ? (
              <div
                data-testid="chinese-community-qr-loading"
                className="size-40 animate-pulse border-2 border-black bg-white"
              />
            ) : showQrImage && config ? (
              <img
                src={config.imageUrl}
                alt={formatMessage({ id: "pages.chineseCommunity.qrAlt" })}
                width={288}
                height={288}
                decoding="sync"
                onError={() => setFailedImageUrl(config.imageUrl)}
                data-testid="chinese-community-qr-image"
                className="size-full object-contain [image-rendering:pixelated]"
              />
            ) : (
              <div
                role="status"
                data-testid="chinese-community-qr-missing"
                className="px-5 text-sm font-bold leading-6 text-black/65"
              >
                {formatMessage({ id: unavailableMessageId })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
