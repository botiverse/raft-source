import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useServerStore } from "../../store/serverStore";

/**
 * Into a channel the account can now open (an accepted external invite's
 * landing): the server list first, so the server is there to enter.
 */
export function useOpenJoinedChannel(): (serverId: string, channelId: string) => Promise<void> {
  const navigate = useNavigate();
  const loadServers = useServerStore((s) => s.loadServers);
  const setCurrent = useServerStore((s) => s.setCurrent);
  // A page that is gone by the time the server list is in doesn't navigate.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return useCallback(async (serverId: string, channelId: string) => {
    await loadServers({ fresh: true });
    if (!mountedRef.current) return;
    const joined = useServerStore.getState().servers.find((server) => server.id === serverId);
    if (!joined) {
      window.location.assign("/");
      return;
    }
    setCurrent(joined);
    navigate(`/s/${joined.slug}/channel/${encodeURIComponent(channelId)}`, { replace: true });
  }, [loadServers, setCurrent, navigate]);
}
