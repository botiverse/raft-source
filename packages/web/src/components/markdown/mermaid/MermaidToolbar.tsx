import {
  Check,
  Code2,
  Copy,
  Download,
  Image as ImageIcon,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  TooltipProvider,
} from "raft-ui";
import type { ImageZoomController } from "../../ImageZoom";
import { useBlobDownload } from "../../../hooks/useBlobDownload";
import Button from "../../ui/Button";
import CopyButton from "../../ui/CopyButton";
import { useLightboxPortalContainer } from "../../ui/Lightbox";
import Spinner from "../../ui/Spinner";
import Tooltip from "../../ui/Tooltip";
import {
  diagramFilename,
  svgToPngBlob,
} from "./mermaidDownload";
import type { MermaidRenderResult } from "./mermaidRenderer";

export type MermaidView = "diagram" | "code";

const ZOOM_FACTOR = 1.2;
const MERMAID_TOOLTIP_DELAY_MS = 600;
const MERMAID_TOOLTIP_CONTENT_CLASS = "r-mermaid-tooltip";
const MERMAID_MOBILE_TOUCH_TARGET_CLASS = "r-mermaid-toolbar__touch-target";

export function MermaidToolbar({
  code,
  view,
  onViewChange,
  result,
  zoom,
  onFullscreen,
  onExportError,
}: {
  code: string;
  view: MermaidView;
  onViewChange: (view: MermaidView) => void;
  result: MermaidRenderResult | null;
  zoom: ImageZoomController;
  onFullscreen: () => void;
  onExportError: (message: string | null) => void;
}) {
  const { formatMessage } = useIntl();
  const downloadBlob = useBlobDownload();
  const lightboxPortalContainer = useLightboxPortalContainer();
  const tooltipContentProps = {
    className: MERMAID_TOOLTIP_CONTENT_CLASS,
    container: lightboxPortalContainer ?? undefined,
  };
  const floatingPortalProps = lightboxPortalContainer
    ? { container: lightboxPortalContainer }
    : undefined;

  const saveSvg = useCallback(() => {
    if (!result) return;
    onExportError(null);
    downloadBlob(
      new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" }),
      diagramFilename(result.svg, "svg"),
    );
  }, [downloadBlob, onExportError, result]);

  const saveSource = useCallback(() => {
    onExportError(null);
    downloadBlob(
      new Blob([code], { type: "text/plain;charset=utf-8" }),
      diagramFilename(code, "mmd"),
    );
  }, [code, downloadBlob, onExportError]);

  const savePng = useCallback(async () => {
    if (!result) return;
    onExportError(null);
    try {
      downloadBlob(await svgToPngBlob(result, {
        imageLoadError: formatMessage({ id: "message.mermaid.pngImageLoadError" }),
        canvasUnavailable: formatMessage({ id: "message.mermaid.pngCanvasUnavailable" }),
        createError: formatMessage({ id: "message.mermaid.pngCreateError" }),
      }), diagramFilename(result.svg, "png"));
    } catch (error) {
      onExportError(
        error instanceof Error && error.message.trim()
          ? error.message
          : formatMessage({ id: "message.mermaid.unknownError" }),
      );
    }
  }, [downloadBlob, formatMessage, onExportError, result]);

  // Diagram actions remain present but disabled when rendering has no result,
  // matching the stable toolbar in the error state. The code view still hides
  // actions that do not apply to the surface the user is looking at.
  const showDiagramActions = view === "diagram";
  const fullscreenControl = showDiagramActions ? (
    <Tooltip
      content={formatMessage({ id: "message.mermaid.fullscreen" })}
      contentProps={tooltipContentProps}
    >
      <Button
        size="xs"
        shape="icon"
        className={MERMAID_MOBILE_TOUCH_TARGET_CLASS}
        disabled={!result}
        onClick={onFullscreen}
        aria-label={formatMessage({ id: "message.mermaid.openFullscreenAria" })}
      >
        <Maximize2 size={14} />
      </Button>
    </Tooltip>
  ) : null;
  const downloadMenu = (
    <DropdownMenu>
      <Tooltip
        content={formatMessage({ id: "message.mermaid.downloadMenu" })}
        contentProps={tooltipContentProps}
      >
        <DropdownMenuTrigger render={(
          <Button
            size="xs"
            shape="icon"
            className={MERMAID_MOBILE_TOUCH_TARGET_CLASS}
            aria-label={formatMessage({ id: "message.mermaid.downloadMenu" })}
          >
            <Download size={14} />
          </Button>
        )} />
      </Tooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        portalProps={floatingPortalProps}
        className="r-mermaid-download-menu"
      >
        <DropdownMenuItem className="r-mermaid-download-menu__item" onClick={saveSource}>
          <Code2 size={13} /> {formatMessage({ id: "message.mermaid.downloadSource" })}
        </DropdownMenuItem>
        <DropdownMenuItem className="r-mermaid-download-menu__item" disabled={!result} onClick={savePng}>
          <Download size={13} /> {formatMessage({ id: "message.mermaid.downloadPng" })}
        </DropdownMenuItem>
        <DropdownMenuItem className="r-mermaid-download-menu__item" disabled={!result} onClick={saveSvg}>
          <Download size={13} /> {formatMessage({ id: "message.mermaid.downloadSvg" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <TooltipProvider delay={MERMAID_TOOLTIP_DELAY_MS}>
      <div
        className="r-mermaid-toolbar"
        data-testid="mermaid-toolbar"
      >
        <div
          className="r-mermaid-toolbar__views"
          role="group"
          aria-label={formatMessage({ id: "message.mermaid.previewMode" })}
        >
          <Button
            size="xs"
            shape="icon"
            className={`${MERMAID_MOBILE_TOUCH_TARGET_CLASS} r-mermaid-toolbar__tab`}
            tone={view === "diagram" ? "yellow" : "white"}
            aria-label={formatMessage({ id: "message.mermaid.diagram" })}
            aria-pressed={view === "diagram"}
            onClick={() => onViewChange("diagram")}
          >
            <ImageIcon size={13} />
            <span className="r-mermaid-toolbar__tab-label">{formatMessage({ id: "message.mermaid.diagram" })}</span>
          </Button>
          <Button
            size="xs"
            shape="icon"
            className={`${MERMAID_MOBILE_TOUCH_TARGET_CLASS} r-mermaid-toolbar__tab`}
            tone={view === "code" ? "yellow" : "white"}
            aria-label={formatMessage({ id: "message.mermaid.code" })}
            aria-pressed={view === "code"}
            onClick={() => onViewChange("code")}
          >
            <Code2 size={13} />
            <span className="r-mermaid-toolbar__tab-label">{formatMessage({ id: "message.mermaid.code" })}</span>
          </Button>
        </div>

        {showDiagramActions ? (
          <div
            className="r-mermaid-toolbar__zoom"
            role="group"
            aria-label={formatMessage({ id: "message.mermaid.zoomControls" })}
          >
            <Tooltip
              content={formatMessage({ id: "message.mermaid.zoomOut" })}
              contentProps={tooltipContentProps}
            >
              <Button
                size="xs"
                shape="icon"
                disabled={!result}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => zoom.zoomBy(1 / ZOOM_FACTOR)}
                aria-label={formatMessage({ id: "message.mermaid.zoomOutAria" })}
              >
                <ZoomOut size={14} />
              </Button>
            </Tooltip>
            <Tooltip
              content={formatMessage({ id: "message.mermaid.zoomIn" })}
              contentProps={tooltipContentProps}
            >
              <Button
                size="xs"
                shape="icon"
                disabled={!result}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => zoom.zoomBy(ZOOM_FACTOR)}
                aria-label={formatMessage({ id: "message.mermaid.zoomInAria" })}
              >
                <ZoomIn size={14} />
              </Button>
            </Tooltip>
          </div>
        ) : null}

        <CopyButton
          text={code}
          resetKey={code}
          onCopyStart={() => onExportError(null)}
          onCopyError={() => onExportError(formatMessage({ id: "message.mermaid.copySourceError" }))}
        >
          {({ copied, pending, disabled, onClick, onMouseDown }) => {
            const copyFeedbackLabel = formatMessage({
              id: pending
                ? "message.mermaid.copyingSource"
                : copied
                  ? "message.mermaid.copiedSource"
                  : "message.mermaid.copySource",
            });
            return (
              <Tooltip
                content={copyFeedbackLabel}
                contentProps={tooltipContentProps}
              >
                <Button
                  size="xs"
                  shape="icon"
                  tone={copied ? "lime" : "white"}
                  className={MERMAID_MOBILE_TOUCH_TARGET_CLASS}
                  disabled={disabled}
                  onMouseDown={onMouseDown}
                  onClick={onClick}
                  aria-label={copyFeedbackLabel}
                >
                  {pending
                    ? <Spinner size="sm" label={copyFeedbackLabel} />
                    : copied
                      ? <Check size={14} />
                      : <Copy size={14} />}
                </Button>
              </Tooltip>
            );
          }}
        </CopyButton>

        {downloadMenu}
        {fullscreenControl}
      </div>
    </TooltipProvider>
  );
}
