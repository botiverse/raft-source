import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { useIntl } from "react-intl";
import { Check, Copy, Download, Share2, X } from "lucide-react";
import { Button } from "raft-ui";
import { downloadDataUrl, resolveCapturePixelRatio } from "../../utils/selectScreenshot";
import {
  copyPngDataUrlToClipboard,
  dataUrlToPngFile,
  resolvePngClipboardCapability,
} from "../../utils/selectMarkdown";
import Lightbox from "../ui/Lightbox";

export interface SelectShareLightboxProps {
  /** The captured PNG, as a data URL. */
  dataUrl: string;
  /** Suggested filename when the user clicks Download. */
  filename?: string;
  /** Called when the user dismisses the preview (Cancel, X, ESC, backdrop). Selection should be preserved. */
  onClose: () => void;
  /** Called after a successful Download. Selection mode should exit here. Defaults to onClose if omitted. */
  onSaved?: () => void;
  /** Optional platform share target. Runs only after the preview PNG already exists. */
  onShareToX?: (dataUrl: string) => Promise<void>;
}

type FileShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

function isMobileBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function canSavePngViaNativeShare(dataUrl: string, filename: string): Promise<boolean> {
  if (!isMobileBrowser()) return false;
  const nav = navigator as FileShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    const file = await dataUrlToPngFile(dataUrl, filename);
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Confirmation lightbox shown after the user clicks "Share..." on the
 * select-mode toolbar. The user reviews the rendered screenshot, then chooses
 * an artifact action. Platform-specific share targets intentionally live here,
 * not in the toolbar, so the image is ready before the user sends it anywhere.
 */
export default function SelectShareLightbox({
  dataUrl,
  filename = "slock-export.png",
  onClose,
  onSaved,
  onShareToX,
}: SelectShareLightboxProps) {
  const { formatMessage } = useIntl();
  const [sharingToX, setSharingToX] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [canCopyImage, setCanCopyImage] = useState(false);
  const [canNativeSaveImage, setCanNativeSaveImage] = useState(false);
  const [previewSourceWidth, setPreviewSourceWidth] = useState<number | null>(null);

  const handlePreviewImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth } = event.currentTarget;
    if (naturalWidth <= 0) return;

    // The capture pipeline rasterizes at resolveCapturePixelRatio(). Keep the
    // lightbox from enlarging a narrow message-column export above the CSS
    // width it was captured at; that interpolation is what makes text look
    // soft while the downloaded PNG remains the correct aspect ratio.
    setPreviewSourceWidth(naturalWidth / resolveCapturePixelRatio());
  };

  // Async-loader probing native share capability. Reset-on-input + arrival.
  // Adjust-rule fires on the reset-to-false setState line too.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setCanNativeSaveImage(false);
    void canSavePngViaNativeShare(dataUrl, filename).then((canSave) => {
      if (!cancelled) setCanNativeSaveImage(canSave);
    });
    return () => {
      cancelled = true;
    };
  }, [dataUrl, filename]);

  useEffect(() => {
    let cancelled = false;
    let permissionStatus: PermissionStatus | null = null;
    const syncPermission = () => {
      if (!cancelled && permissionStatus) {
        setCanCopyImage(permissionStatus.state !== "denied");
      }
    };

    void resolvePngClipboardCapability().then((capability) => {
      if (cancelled) return;
      permissionStatus = capability.permissionStatus;
      setCanCopyImage(capability.available);
      permissionStatus?.addEventListener("change", syncPermission);
    });

    return () => {
      cancelled = true;
      permissionStatus?.removeEventListener("change", syncPermission);
    };
  }, []);

  const handleDownload = async () => {
    if (sharingToX || savingImage || copyingImage) return;
    if (!canNativeSaveImage) {
      downloadDataUrl(dataUrl, filename);
      (onSaved ?? onClose)();
      return;
    }

    setSavingImage(true);
    try {
      const file = await dataUrlToPngFile(dataUrl, filename);
      const nav = navigator as FileShareNavigator;
      await nav.share?.({
        files: [file],
        title: formatMessage({ id: "message.selectShare.nativeShareTitle" }),
      });
      (onSaved ?? onClose)();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      downloadDataUrl(dataUrl, filename);
      (onSaved ?? onClose)();
    } finally {
      setSavingImage(false);
    }
  };

  const handleCopyImage = async () => {
    if (sharingToX || savingImage || copyingImage) return;
    setCopyingImage(true);
    setImageCopied(false);
    setCopyError(null);
    try {
      await copyPngDataUrlToClipboard(dataUrl);
      setImageCopied(true);
    } catch (err) {
      console.error("copyPngDataUrlToClipboard failed:", err);
      const errorName = typeof err === "object" && err !== null && "name" in err
        ? String(err.name)
        : "";
      if (errorName === "NotAllowedError") {
        setCanCopyImage(false);
      } else {
        setCopyError(formatMessage({ id: "message.share.copyImageFailed" }));
      }
    } finally {
      setCopyingImage(false);
    }
  };

  const handleShareToX = async () => {
    if (!onShareToX || sharingToX || savingImage || copyingImage) return;
    setSharingToX(true);
    try {
      await onShareToX(dataUrl);
    } finally {
      setSharingToX(false);
    }
  };

  return (
    <Lightbox
      onClose={onClose}
      zIndex={100}
      backdropClass="bg-black/60"
      className="flex items-center justify-center p-4"
      data-testid="select-share-lightbox"
    >
      <div
        className="card-brutal flex max-h-[90vh] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-panel-header shrink-0 items-center justify-between border-b-2 border-black bg-white px-5">
          <h2 className="text-base font-bold text-black">{formatMessage({ id: "message.selectShare.title" })}</h2>
          <Button
            type="button"
            onClick={onClose}
            size="icon-sm"
            variant="default"
            aria-label={formatMessage({ id: "common.close" })}
            data-testid="select-share-lightbox-close"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="flex-1 overflow-auto bg-white p-4">
          <img
            src={dataUrl}
            alt={formatMessage({ id: "message.selectShare.alt" })}
            className="mx-auto block max-w-full border-2 border-black shadow-brutal"
            onLoad={handlePreviewImageLoad}
            style={previewSourceWidth ? { width: `${previewSourceWidth}px` } : undefined}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-2 border-black bg-white px-4 py-3 sm:px-5">
          {copyError && (
            <p
              role="alert"
              className="mr-auto text-sm font-medium text-red-700"
              data-testid="select-share-lightbox-copy-error"
            >
              {copyError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canCopyImage && (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => void handleCopyImage()}
                disabled={sharingToX || savingImage || copyingImage}
                loading={copyingImage}
                loadingLabel={formatMessage({ id: "message.selectShare.copying" })}
                data-testid="select-share-lightbox-copy-image"
              >
                {imageCopied ? <Check /> : <Copy />}
                {imageCopied
                  ? formatMessage({ id: "message.selectShare.copied" })
                  : formatMessage({ id: "message.selectShare.copyImage" })}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => void handleDownload()}
              disabled={sharingToX || savingImage || copyingImage}
              loading={savingImage}
              loadingLabel={formatMessage({ id: "message.selectShare.saving" })}
              data-testid="select-share-lightbox-download"
            >
              <Download />
              {canNativeSaveImage
                ? formatMessage({ id: "message.selectShare.saveImage" })
                : formatMessage({ id: "common.lightbox.download" })}
            </Button>
            {onShareToX && (
              <Button
                type="button"
                size="sm"
                variant="accent"
                onClick={() => void handleShareToX()}
                disabled={sharingToX || savingImage || copyingImage}
                loading={sharingToX}
                loadingLabel={formatMessage({ id: "message.selectShare.sharing" })}
                data-testid="select-share-lightbox-share-x"
              >
                <Share2 />
                {formatMessage({ id: "message.selectShare.shareToX" })}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Lightbox>
  );
}
