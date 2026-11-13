import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { CreateChannelDialog } from "./DeferredCreateChannelDialog";
import { CreateJointChannelDialog } from "./DeferredCreateJointChannelDialog";
import { useExternalChannelCreateAccess } from "./externalInvites";

/**
 * Feature-owned link intent, available even when a sidebar is hidden. With
 * external_channels_v1 on, the link opens Create Channel with External chosen
 * (design v5.0 E1: the old Create Joint Channel dialog is gone), for whoever
 * Create Channel offers External to; off, the Joint Channel dialog as before.
 */
export default function JointChannelLinkIntent() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverId = useServerStore((state) => state.current?.id);
  const { capabilities } = useServerPermissions();
  const externalChannels = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);
  const externalChannelsEnabled = externalChannels.enabled;
  const externalChannelCreateAccess = useExternalChannelCreateAccess();
  const canOpen = externalChannelsEnabled ? externalChannelCreateAccess : capabilities.federateChannels;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const close = useCallback(() => setOpenedFor(null), []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("dialog") !== "create-joint-channel") return;
    query.delete("dialog");
    navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, { replace: true });
    if (serverId) setOpenedFor(serverId);
  }, [location.search, location.pathname, location.hash, navigate, serverId]);
  // Which dialog, and whether at all, waits for the flag: never the old one
  // first for a Server that has External.
  if (openedFor !== serverId || !externalChannels.resolved || !canOpen) return null;
  return externalChannelsEnabled
    ? <CreateChannelDialog prefilledVisibility="external" inviteEntry="link" onClose={close} />
    : <CreateJointChannelDialog onClose={close} />;
}
