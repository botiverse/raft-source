import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useServerStore } from "../../store/serverStore";
import type { CommunityServerSlug, Server } from "../../store/serverStore";
import { serverPersistence } from "../../store/serverPersistenceRegistry";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useJoinCommunityFlow } from "../../hooks/useJoinCommunityFlow";
import { DEFAULT_COMMUNITY_SERVER_SLUG, hasJoinedCommunity } from "../../utils/communityServers";
import { requestHostedOnboardingServerSwitch } from "../../embed/hostBridge";
import { InviteHumanDialog } from "../member/DeferredInviteHumanDialog";

export interface ServerSwitcherJoinOption {
  kind: "community-server";
  slug: CommunityServerSlug;
  label: string;
}

export interface ServerSwitcher {
  /** The server the person is in. */
  current: Server | null;
  /** Every joined server, in the order the person dragged them into. */
  servers: Server[];
  sortableServerIds: string[];
  /** Saves a dragged order: the one order behind every server list. Each
   *  list mounts its own sensors (a mouse drags by 6px, a finger holds, then
   *  moves) beside the touchDragRegion of its drag surface. */
  handleServerDragEnd: (event: DragEndEvent) => void;
  /** A hosted onboarding shell is switching for us: rows wait. */
  hostedSwitchPending: boolean;
  hostedSwitchError: string;
  selectServer: (server: Server, targetHref: string) => void;
  joinOptions: ServerSwitcherJoinOption[];
  joinCommunity: (slug: CommunityServerSlug) => void;
  switchOrCreate: () => void;
  canInviteHuman: boolean;
  inviteHuman: () => void;
  /** The dialogs the actions open. Render them beside the popup, not in it:
   *  they outlive the list, which closes as soon as one of them opens. */
  dialogs: ReactNode;
}

/**
 * The workspace switcher's data and actions, shared by every list that shows
 * it: the rail / top bar / phone Home menu (ServerSwitcherMenu) and the phone
 * server tab's popover (MobileServerTab). One order, one set of unread rules,
 * one set of footer actions, so the lists cannot drift.
 *
 * `replace`: a phone switch replaces the old server's entry, so a later Back
 * cannot cross into the previous server.
 */
export function useServerSwitcher({ onClose, replace }: { onClose: () => void; replace: boolean }): ServerSwitcher {
  const intl = useIntl();
  const navigate = useNavigate();
  const current = useServerStore((s) => s.current);
  const servers = useServerStore((s) => s.servers);
  const updateServerOrder = useServerStore((s) => s.updateServerOrder);
  const [hostedSwitchPending, setHostedSwitchPending] = useState(false);
  const [hostedSwitchError, setHostedSwitchError] = useState("");
  const [showInviteHuman, setShowInviteHuman] = useState(false);
  const { capabilities } = useServerPermissions();
  const hostedSwitchTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: () => {
      onClose();
    },
    onError: (_error, _slug, message) => {
      onClose();
      // Surfacing via alert matches the other low-frequency
      // sidebar failure modes until we have a shared toast system.
      // eslint-disable-next-line no-alert
      alert(message);
    },
  });

  useEffect(() => () => {
    if (hostedSwitchTimeoutRef.current !== null) clearClockTimeout(hostedSwitchTimeoutRef.current);
  }, []);

  const selectServer = useCallback((selected: Server, targetHref: string) => {
    const isCurrent = selected.id === current?.id;
    if (!isCurrent) {
      const outcome = requestHostedOnboardingServerSwitch(selected.id);
      if (outcome === "sent") {
        setHostedSwitchError("");
        setHostedSwitchPending(true);
        hostedSwitchTimeoutRef.current = setClockTimeout(() => {
          hostedSwitchTimeoutRef.current = null;
          setHostedSwitchPending(false);
          setHostedSwitchError(intl.formatMessage({ id: "pages.serverSelector.switchFailed" }));
        }, 5000);
        return;
      }
      if (outcome === "failed") {
        setHostedSwitchError(intl.formatMessage({ id: "pages.serverSelector.switchFailed" }));
        return;
      }
      // Let the URL be the source of truth; ServerResolver will switch the
      // current server after the route changes.
      navigate(targetHref, replace ? { replace: true } : undefined);
    }
    onClose();
  }, [current?.id, intl, navigate, onClose, replace]);

  const handleServerDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const oldIndex = servers.findIndex((candidate) => candidate.id === activeId);
    const newIndex = servers.findIndex((candidate) => candidate.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(servers, oldIndex, newIndex).map((candidate) => candidate.id);
    void updateServerOrder(reordered);
  }, [servers, updateServerOrder]);

  const sortableServerIds = useMemo(() => servers.map((candidate) => candidate.id), [servers]);

  const joinOptions: ServerSwitcherJoinOption[] = [];
  if (!hasJoinedCommunity(servers, DEFAULT_COMMUNITY_SERVER_SLUG)) {
    joinOptions.push({ kind: "community-server", slug: DEFAULT_COMMUNITY_SERVER_SLUG, label: intl.formatMessage({ id: "ui.serverSwitcher.joinCommunity" }) });
  }

  const joinCommunity = useCallback((slug: CommunityServerSlug) => {
    void communityJoinFlow.joinCommunity(slug);
  }, [communityJoinFlow]);

  const switchOrCreate = useCallback(() => {
    onClose();
    serverPersistence.clearLastServerSlug();
    navigate("/");
  }, [navigate, onClose]);

  // "Invite people" sits right under "Switch or create server" so inviting
  // teammates is one click from the workspace menu instead of buried in
  // Settings → Administration. Gated by the same capability the Settings
  // invites section uses; opens the shared InviteHumanDialog.
  const inviteHuman = useCallback(() => {
    onClose();
    setShowInviteHuman(true);
  }, [onClose]);
  const closeInviteDialog = useCallback(() => setShowInviteHuman(false), []);

  const dialogs = (
    <>
      {communityJoinFlow.agreementDialog}
      {showInviteHuman ? <InviteHumanDialog onClose={closeInviteDialog} surface="server_menu" /> : null}
    </>
  );

  return {
    current,
    servers,
    sortableServerIds,
    handleServerDragEnd,
    hostedSwitchPending,
    hostedSwitchError,
    selectServer,
    joinOptions,
    joinCommunity,
    switchOrCreate,
    canInviteHuman: capabilities.inviteMembers,
    inviteHuman,
    dialogs,
  };
}
