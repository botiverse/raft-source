import { useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { BookOpenText, Download, Keyboard, UsersRound } from "lucide-react";
import { DropdownMenuShortcut, PopoverContent, Spinner } from "@botiverse/raft-ui";
import { FeedbackIcon } from "@botiverse/ricons";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import AttentionDot from "../ui/AttentionDot";
import MenuItem from "../ui/MenuItem";
import LeavingRaftMark from "../ui/LeavingRaftMark";
import SectionEyebrow from "../ui/SectionEyebrow";
import { useJoinCommunityFlow } from "../../hooks/useJoinCommunityFlow";
import {
  CHINESE_COMMUNITY_PAGE_PATH,
  DEFAULT_COMMUNITY_SERVER_SLUG,
  shouldShowChineseCommunityEntry,
} from "../../utils/communityServers";
import { useShortcutBinding } from "../../features/shortcuts/useShortcutBinding";
import { useShortcutHelpStore } from "../../features/keyboard-shortcuts/shortcutHelpStore";

function initialFocusForKeyboardOpen(openType: string) {
  return openType === "keyboard";
}

/**
 * The rail's Help & resources menu (LeftRail): documentation, keyboard
 * shortcuts, getting the app, feedback and the community.
 */
export function HelpMenu({
  servers,
  serverSlugOverride,
  side = "right",
  onClose,
  showMobileAppBadge,
  onMobileAppOpened,
  onOpenFeedback,
  onOpenMobileApp,
  keyboardShortcuts = false,
}: {
  servers: Server[];
  serverSlugOverride?: string;
  /** Where the menu opens from its trigger: beside the rail, or under the top bar. */
  side?: "right" | "bottom";
  onClose: () => void;
  showMobileAppBadge: boolean;
  onMobileAppOpened: () => void;
  onOpenFeedback?: () => void;
  onOpenMobileApp?: () => void;
  /** Offer Keyboard Shortcuts: only where the panel can open (a server page's MainLayout). */
  keyboardShortcuts?: boolean;
}) {
  const { formatMessage, locale } = useIntl();
  const helpShortcut = useShortcutBinding("open-help");
  const navigate = useNavigate();
  const storedServerSlug = useServerStore((state) => state.current?.slug ?? null);
  const serverSlug = serverSlugOverride ?? storedServerSlug;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: () => {
      onCloseRef.current();
    },
    onError: (_error, _slug, message) => {
      onCloseRef.current();
      // Surfacing via alert matches the existing ServerSwitcherMenu join flow
      // until the app has one shared toast surface for low-frequency failures.
      // eslint-disable-next-line no-alert
      alert(message);
    },
  });
  const showChineseCommunityEntry = shouldShowChineseCommunityEntry(locale);

  const openDocumentation = useCallback(() => {
    onCloseRef.current();
    window.open("https://docs.raft.build", "_blank", "noopener,noreferrer");
  }, []);

  const openFeedback = useCallback(() => {
    if (!serverSlug) return;
    onCloseRef.current();
    if (onOpenFeedback) {
      onOpenFeedback();
      return;
    }
    navigate(`/s/${serverSlug}/settings/feedback`);
  }, [navigate, onOpenFeedback, serverSlug]);
  const openMobileApp = useCallback(() => {
    if (!serverSlug) return;
    // Mark seen on open, not on menu-open: the dot is announcing the mobile app,
    // and someone who opened Help to reach Feedback has not been told about it.
    onMobileAppOpened();
    onCloseRef.current();
    if (onOpenMobileApp) {
      onOpenMobileApp();
      return;
    }
    navigate(`/s/${serverSlug}/settings/about`);
  }, [navigate, onMobileAppOpened, onOpenMobileApp, serverSlug]);

  // The panel takes focus as it opens. The closing menu leaves it there:
  // Base UI hands focus back to the trigger only if it is still in the menu.
  const openKeyboardShortcuts = useCallback(() => {
    onCloseRef.current();
    useShortcutHelpStore.getState().openWithFocus();
  }, []);

  const { joinCommunity } = communityJoinFlow;
  const openCommunity = useCallback(async () => {
    if (showChineseCommunityEntry) {
      onCloseRef.current();
      navigate(`${CHINESE_COMMUNITY_PAGE_PATH}?from=help-menu`);
      return;
    }
    const joinedDefault = servers.find((candidate) => candidate.slug === DEFAULT_COMMUNITY_SERVER_SLUG);
    if (joinedDefault) {
      onCloseRef.current();
      navigate(`/s/${joinedDefault.slug}`);
      return;
    }
    const outcome = await joinCommunity(DEFAULT_COMMUNITY_SERVER_SLUG);
    if (outcome.status === "agreement_required") onCloseRef.current();
  }, [joinCommunity, navigate, servers, showChineseCommunityEntry]);
  const handleCommunityClick = useCallback(() => {
    void openCommunity();
  }, [openCommunity]);

  return (
    <>
      <PopoverContent
        side={side}
        align="end"
        sideOffset={8}
        initialFocus={initialFocusForKeyboardOpen}
        role="menu"
        aria-label={formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
        data-testid="left-rail-help-menu"
        className="w-80 overflow-hidden p-0"
      >
          <div className="flex items-center border-b border-line-hairline px-3 py-2">
            <SectionEyebrow>
              {formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
            </SectionEyebrow>
          </div>
          {/* The rows sit in a 4px list, like raft-ui's menus. */}
          <div className="flex flex-col p-1">
          <MenuItem
            icon={<BookOpenText size={14} className="shrink-0" />}
            // ↗ where a shortcut goes, in the hint color (raft-design
            // navigation.md "Links that leave Raft").
            trailing={<LeavingRaftMark className="size-3.5 text-foreground-hint" />}
            onClick={openDocumentation}
          >
            {formatMessage({ id: "layout.leftRail.helpDocumentation" })}
          </MenuItem>
          {keyboardShortcuts ? (
            <MenuItem
              icon={<Keyboard size={14} className="shrink-0" />}
              // Raft DS › Kbd, Menus: a menu's shortcut is raft-ui's menu
              // shortcut (a bare `sm` Kbd, no cap), a string written the
              // platform's way: ⌘/ on a Mac, Ctrl+/ elsewhere.
              trailing={<DropdownMenuShortcut aria-hidden="true">{helpShortcut.menuText}</DropdownMenuShortcut>}
              aria-keyshortcuts={helpShortcut.ariaKeyShortcuts}
              onClick={openKeyboardShortcuts}
              data-testid="help-menu-keyboard-shortcuts"
            >
              {formatMessage({ id: "layout.leftRail.helpKeyboardShortcuts" })}
            </MenuItem>
          ) : null}
          {/* Signpost only — the content lives in Settings so there is one host
              to keep current, not two that can drift. One row for every app
              (raft-design "Getting the app"): Settings → About puts this
              device's app first, the desktop build on the web, the phone
              apps inside the desktop app (Jasper, #proj-frontend:2f865f11). */}
          {serverSlug ? (
            <MenuItem
              icon={<Download size={14} className="shrink-0" />}
              // `lg` is the canonical dot; `sm` is compact-only, for parents
              // that physically cannot fit 10×10. A menu row fits it easily —
              // I reached for `sm` to make it feel less shouty, which is the
              // priority axis the design system explicitly does not have. At
              // 4×4 it rendered as a speck that read as a rendering artefact
              // rather than a signal (@wenyi, preview review).
              trailing={showMobileAppBadge
                ? (
                  <AttentionDot
                    className="shrink-0"
                    aria-hidden="true"
                    data-testid="help-menu-mobile-app-badge"
                  />
                )
                : undefined}
              onClick={openMobileApp}
              data-testid="help-menu-get-app"
            >
              {formatMessage({ id: "layout.leftRail.helpGetApp" })}
            </MenuItem>
          ) : null}
          {serverSlug ? (
            <MenuItem
              icon={<FeedbackIcon width={14} height={14} className="shrink-0" />}
              onClick={openFeedback}
            >
              {formatMessage({ id: "settings.about.feedbackTitle" })}
            </MenuItem>
          ) : null}
          <MenuItem
            icon={communityJoinFlow.joiningCommunitySlug
              ? <Spinner size="sm" aria-hidden="true"  aria-label={formatMessage({ id: "common.loadingLabel" })} />
              : <UsersRound size={14} className="shrink-0" />}
            onClick={handleCommunityClick}
            disabled={communityJoinFlow.joiningCommunitySlug !== null}
          >
            {communityJoinFlow.joiningCommunitySlug
              ? formatMessage({ id: "layout.leftRail.helpCommunityJoining" })
              : formatMessage({
                  id: showChineseCommunityEntry
                    ? "layout.leftRail.helpChineseCommunity"
                    : "layout.leftRail.helpCommunity",
                })}
          </MenuItem>
          </div>
      </PopoverContent>
      {communityJoinFlow.agreementDialog}
    </>
  );
}
