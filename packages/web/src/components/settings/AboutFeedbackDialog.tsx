import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react/source";
import type {
  FeedbackWorkspaceNavigationOptions,
  FeedbackWorkspaceRoute,
} from "@botiverse/hands-feedback-react/source";
import { Download, X } from "lucide-react";
import {
  Button,
  Lightbox,
  LightboxActions,
  LightboxClose,
  LightboxContent,
  LightboxMedia,
  LightboxStage,
  LightboxTitle,
  LightboxToolbar,
} from "raft-ui";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../../api/client";
import { handsFeedbackTransport } from "../../feedback/handsFeedbackTransport";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useLocale } from "../../i18n/LocaleProvider";
import Banner from "../ui/Banner";

const FEEDBACK_SETTINGS_SEGMENT = "/settings/feedback";

export function feedbackWorkspaceBasePath(pathname: string): string {
  const match = new RegExp(
    `^(.*${FEEDBACK_SETTINGS_SEGMENT})(?:/|$)`,
  ).exec(pathname);
  if (match?.[1]) return match[1];
  return pathname.replace(/\/+$/, "") || "/";
}

export function feedbackWorkspaceRouteFromPath(
  pathname: string,
): FeedbackWorkspaceRoute {
  const basePath = feedbackWorkspaceBasePath(pathname);
  const suffix = pathname
    .slice(basePath.length)
    .replace(/^\/+|\/+$/g, "");
  if (suffix === "new") return { view: "new" };
  const ticketMatch = /^ticket\/([^/]+)$/.exec(suffix);
  if (ticketMatch?.[1]) {
    try {
      return {
        view: "ticket",
        ticketId: decodeURIComponent(ticketMatch[1]),
      };
    } catch {
      return { view: "inbox" };
    }
  }
  return { view: "inbox" };
}

export function feedbackWorkspacePath(
  basePath: string,
  route: FeedbackWorkspaceRoute,
): string {
  if (route.view === "new") return `${basePath}/new`;
  if (route.view === "ticket" && route.ticketId)
    return `${basePath}/ticket/${encodeURIComponent(route.ticketId)}`;
  return basePath;
}

function attachmentFilename(headers: unknown, fallback: string): string {
  if (!headers || typeof headers !== "object") return fallback;
  const headerRecord = headers as Record<string, unknown>;
  const get = headerRecord.get;
  const value = typeof get === "function"
    ? Reflect.apply(get, headers, ["content-disposition"])
    : headerRecord["content-disposition"];
  if (typeof value !== "string") return fallback;

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
  const quoted = /filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(value)?.[1];
  const unquoted = /filename\s*=\s*([^;\s]+)/i.exec(value)?.[1];
  let filename = fallback;
  try {
    filename = encoded
      ? decodeURIComponent(encoded)
      : (quoted?.replace(/\\(.)/g, "$1") ?? unquoted ?? fallback);
  } catch {
    filename = fallback;
  }

  const basename = [...(filename.split(/[\\/]/).at(-1) ?? "")]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim();
  return basename || fallback;
}

export default function AboutFeedbackPanel() {
  const { locale } = useLocale();
  const { formatMessage } = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const feedbackBasePath = useMemo(
    () => feedbackWorkspaceBasePath(location.pathname),
    [location.pathname],
  );
  const pathRoute = useMemo(
    () => feedbackWorkspaceRouteFromPath(location.pathname),
    [location.pathname],
  );
  const onMobileBack = useMobileBack(feedbackBasePath);
  const controlledRoute =
    isMobile || pathRoute.view !== "inbox" ? pathRoute : undefined;
  const [attachmentError, setAttachmentError] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    filename: string;
    url: string;
  } | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);

  const closeAttachmentPreview = useCallback(() => {
    previewRequestRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setAttachmentPreview(null);
  }, []);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  const openAttachment = useCallback(async (input: {
    ticketId: string;
    attachmentId: string;
  }) => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setAttachmentError(false);
    try {
      const { data, headers } = await api.get<Blob>(
        `/product-feedback/tickets/${encodeURIComponent(input.ticketId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
        { responseType: "blob" },
      );
      if (previewRequestRef.current !== request) return;
      const url = URL.createObjectURL(data);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setAttachmentPreview({
        filename: attachmentFilename(
          headers,
          `feedback-attachment-${input.attachmentId}`,
        ),
        url,
      });
    } catch {
      if (previewRequestRef.current === request) setAttachmentError(true);
    }
  }, []);

  const openPendingAttachment = useCallback((input: { file: File }) => {
    previewRequestRef.current += 1;
    setAttachmentError(false);
    const url = URL.createObjectURL(input.file);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setAttachmentPreview({ filename: input.file.name, url });
  }, []);

  const downloadAttachment = useCallback(() => {
    if (!attachmentPreview) return;
    const link = document.createElement("a");
    link.href = attachmentPreview.url;
    link.download = attachmentPreview.filename;
    link.click();
  }, [attachmentPreview]);

  const onWorkspaceRouteChange = useCallback((
    nextRoute: FeedbackWorkspaceRoute,
    options?: FeedbackWorkspaceNavigationOptions,
  ) => {
    if (nextRoute.view === "inbox") {
      if (feedbackWorkspaceRouteFromPath(location.pathname).view !== "inbox")
        onMobileBack();
      return;
    }
    navigate(feedbackWorkspacePath(feedbackBasePath, nextRoute), {
      replace: options?.replace,
    });
  }, [feedbackBasePath, location.pathname, navigate, onMobileBack]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-layer-primary">
      {attachmentError && (
        <Banner intent="warning" density="sm" className="mx-4 mt-3" role="alert">
          {formatMessage({ id: "settings.about.feedbackAttachmentOpenError" })}
        </Banner>
      )}
      <div className="min-h-0 flex-1">
        <FeedbackProvider
          transport={handsFeedbackTransport}
          theme="brutal"
          locale={locale === "zh-cn" ? "zh-CN" : "en"}
        >
          <FeedbackWorkspace
            enablePullToRefresh={isMobile}
            {...(controlledRoute
              ? {
                  route: controlledRoute,
                  onRouteChange: onWorkspaceRouteChange,
                }
              : {})}
            onOpenAttachment={(input) => void openAttachment(input)}
            onOpenPendingAttachment={openPendingAttachment}
          />
        </FeedbackProvider>
      </div>
      {attachmentPreview && (
        <Lightbox
          open
          onOpenChange={(open) => {
            if (!open) closeAttachmentPreview();
          }}
        >
          <LightboxContent aria-label={attachmentPreview.filename}>
            <LightboxToolbar>
              <LightboxTitle>{attachmentPreview.filename}</LightboxTitle>
              <LightboxActions>
                <Button
                  aria-label={formatMessage({ id: "common.lightbox.download" })}
                  title={formatMessage({ id: "common.lightbox.download" })}
                  size="icon-md"
                  variant="outline"
                  onClick={downloadAttachment}
                >
                  <Download aria-hidden="true" size={16} />
                </Button>
                <LightboxClose
                  aria-label={formatMessage({ id: "common.lightbox.close" })}
                  title={formatMessage({ id: "common.lightbox.close" })}
                >
                  <X aria-hidden="true" size={16} />
                </LightboxClose>
              </LightboxActions>
            </LightboxToolbar>
            <LightboxStage>
              <LightboxMedia>
                <img
                  alt={attachmentPreview.filename}
                  className="h-auto max-h-full w-full max-w-full object-contain"
                  src={attachmentPreview.url}
                />
              </LightboxMedia>
            </LightboxStage>
          </LightboxContent>
        </Lightbox>
      )}
    </div>
  );
}
