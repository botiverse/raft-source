import { feedbackWorkspacePath } from "../../feedback/feedbackPaths";
import {
  feedbackTicketPlatformFromSearch,
  feedbackTicketPlatformParams,
  rememberFeedbackTicketPlatform,
} from "../../feedback/feedbackTicketPlatform";
import { feedbackTicketSearch } from "../../feedback/feedbackTicketLink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackProvider,
  FeedbackWorkspace,
} from "@botiverse/hands-feedback-react";
import type {
  FeedbackWorkspaceNavigationOptions,
  FeedbackWorkspaceRoute,
} from "@botiverse/hands-feedback-react";
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
} from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../../api/client";
import { handsFeedbackTransport } from "../../feedback/handsFeedbackTransport";
import { useFeedbackListDegraded } from "../../feedback/feedbackListDegradedState";
import { useAgentFeedbackSent } from "../../feedback/agentFeedbackSentFlag";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useLocale } from "../../i18n/LocaleProvider";
import { useAuthStore } from "../../store/authStore";
import Banner from "../ui/Banner";
import PanelHeader from "../ui/PanelHeader";
import Tooltip from "../ui/Tooltip";
import { useOverlayTitleBar } from "../topbar/overlayTitleBar";
import { FeedbackAgentHint } from "./FeedbackAgentHint";
import { FeedbackTicketLinkAction } from "./FeedbackTicketLinkAction";

const FEEDBACK_SETTINGS_SEGMENT = "/settings/feedback";


const PANEL_HEADER_CONTAINER_PROPS = {
  "data-testid": "settings-feedback-panel-header",
  "data-slock-settings-tab": "feedback",
};

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

export { feedbackWorkspacePath };

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
  // Desktop: the screenshot preview's toolbar is the window's title bar while open.
  const previewTitleBar = useOverlayTitleBar();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const feedbackBasePath = useMemo(
    () => feedbackWorkspaceBasePath(location.pathname),
    [location.pathname],
  );
  const settingsBackPath = useMemo(
    () => feedbackBasePath.replace(/\/settings\/feedback$/, "/settings"),
    [feedbackBasePath],
  );
  const pathRoute = useMemo(
    () => feedbackWorkspaceRouteFromPath(location.pathname),
    [location.pathname],
  );
  // A link copied in a mobile App names the App its ticket lives in. Recorded
  // while rendering (idempotent), before the workspace below reads the ticket.
  if (pathRoute.view === "ticket" && pathRoute.ticketId)
    rememberFeedbackTicketPlatform(pathRoute.ticketId, feedbackTicketPlatformFromSearch(location.search));
  const onSettingsBack = useMobileBack(settingsBackPath);
  const onWorkspaceBack = useMobileBack(feedbackBasePath);
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);
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
        { responseType: "blob", params: feedbackTicketPlatformParams(input.ticketId) },
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
        onWorkspaceBack();
      return;
    }
    // A mobile App's ticket keeps its `?platform=` (feedbackTicketPlatform.ts).
    const search = nextRoute.view === "ticket" && nextRoute.ticketId
      ? feedbackTicketSearch(nextRoute.ticketId)
      : "";
    navigate(`${feedbackWorkspacePath(feedbackBasePath, nextRoute)}${search}`, {
      replace: options?.replace,
    });
  }, [feedbackBasePath, location.pathname, navigate, onWorkspaceBack]);

  const handleOpenAttachment = useCallback(
    (input: { ticketId: string; attachmentId: string }) => void openAttachment(input),
    [openAttachment],
  );

  const handleLightboxOpenChange = useCallback((open: boolean) => {
    if (!open) closeAttachmentPreview();
  }, [closeAttachmentPreview]);

  const listDegraded = useFeedbackListDegraded();
  const isInbox = pathRoute.view === "inbox";
  // A ticket and New feedback are pages of their own: the workspace draws
  // their header (Back, the ticket's title, its status), which takes this
  // page header's place instead of stacking under it.
  const showPageHeader = isInbox;
  // The agent hint (FeedbackAgentHint) sits on its own line under the inbox's
  // toolbar (New feedback) and above the list. The inbox only: not on a
  // ticket, and not in the composer, where the person already chose to write
  // it. Not once they sent an agent's draft in this browser. Null otherwise,
  // so the slot draws no empty inset.
  const userId = useAuthStore((state) => state.user?.id);
  const agentDraftSent = useAgentFeedbackSent(userId);
  // The inbox's one notice line (DS: at most one banner in one place), between
  // the toolbar and the list: Hands being briefly unavailable outranks the hint.
  // Polite status, not an alert: the transport keeps retrying the first page,
  // so the list stays loading (or keeps what it showed) instead of "no feedback".
  const inboxNotice = useMemo(() => {
    if (!showPageHeader) return null;
    if (listDegraded) {
      return (
        <Banner intent="warning" density="sm" role="status" data-testid="settings-feedback-list-degraded">
          {formatMessage({ id: "settings.about.feedbackListDegraded" })}
        </Banner>
      );
    }
    return agentDraftSent ? null : <FeedbackAgentHint />;
  }, [showPageHeader, listDegraded, agentDraftSent, formatMessage]);
  const mobileBackProps = useMemo(
    () => isInbox
      ? {
          "data-testid": "settings-feedback-mobile-back",
          title: formatMessage({ id: "settings.tabs.back" }),
        }
      : undefined,
    [formatMessage, isInbox],
  );

  return (
    <div className="slock-feedback-panel flex h-full min-h-0 flex-col bg-layer-canvas">
      {showPageHeader && (
        <PanelHeader
          title={formatMessage({ id: "settings.about.feedbackTitle" })}
          containerProps={PANEL_HEADER_CONTAINER_PROPS}
          onMobileBack={isInbox ? onSettingsBack : undefined}
          mobileBackProps={mobileBackProps}
        />
      )}
      {attachmentError && (
        <div className="px-4 pt-3">
          <Banner intent="warning" density="sm" role="alert">
            {formatMessage({ id: "settings.about.feedbackAttachmentOpenError" })}
          </Banner>
        </div>
      )}
      <div className="min-h-0 flex-1" ref={workspaceRootRef}>
        <FeedbackProvider
          transport={handsFeedbackTransport}
          // The feedback SDK ships en and zh-CN; a Traditional Chinese reader gets Chinese.
          locale={locale === "zh-cn" || locale === "zh-tw" ? "zh-CN" : "en"}
        >
          <FeedbackWorkspace
            enablePullToRefresh={isMobile}
            hideHeaderTitle
            // The URL drives the workspace at every width: a ticket and New
            // feedback have addresses of their own (reload, Back, Copy link).
            route={pathRoute}
            onRouteChange={onWorkspaceRouteChange}
            onOpenAttachment={handleOpenAttachment}
            onOpenPendingAttachment={openPendingAttachment}
            inboxNotice={inboxNotice}
          />
        </FeedbackProvider>
        {pathRoute.view === "ticket" && pathRoute.ticketId && (
          <FeedbackTicketLinkAction rootRef={workspaceRootRef} ticketId={pathRoute.ticketId} />
        )}
      </div>
      {attachmentPreview && (
        <Lightbox
          open
          onOpenChange={handleLightboxOpenChange}
        >
          <LightboxContent aria-label={attachmentPreview.filename}>
            <LightboxToolbar {...previewTitleBar}>
              <LightboxTitle>{attachmentPreview.filename}</LightboxTitle>
              <LightboxActions>
                <Tooltip content={formatMessage({ id: "common.lightbox.download" })}>
                <Button
                  aria-label={formatMessage({ id: "common.lightbox.download" })}
                  data-slot="button"
                  size="icon-lg"
                  variant="outline"
                  onClick={downloadAttachment}
                >
                  <Download aria-hidden="true" size={16} />
                </Button>
                </Tooltip>
                <Tooltip content={formatMessage({ id: "common.lightbox.close" })}>
                <LightboxClose
                  aria-label={formatMessage({ id: "common.lightbox.close" })}
                  data-slot="lightbox-close"
                >
                  <X aria-hidden="true" size={16} />
                </LightboxClose>
                </Tooltip>
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
