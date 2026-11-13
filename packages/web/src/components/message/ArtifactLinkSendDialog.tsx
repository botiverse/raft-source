import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import type { ArtifactLinkSendDialogProps } from "../../apps/artifacts";
import { useChannelStore } from "../../store/channelStore";
import { serverPersistence } from "../../store/serverPersistenceRegistry";
import { bootListKey, loadedWithin, useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { ForwardComposer, useForwardDestinations } from "./ForwardComposerDialog";
import { ForwardServerSwitch } from "./ForwardServerSwitch";
import { useArtifactLinkForwardSource } from "./artifactLinkForwardSource";
import { useCrossServerForwardSearch } from "./crossServerForwardSearch";

/** Where the dialog starts: the server the reader was last in, else the current one, else their first. */
function startingServer(servers: readonly Server[], lastSlug: string | null, currentId: string | null): Server | null {
  return (lastSlug ? servers.find((server) => server.slug === lastSlug) : undefined)
    ?? (currentId ? servers.find((server) => server.id === currentId) : undefined)
    ?? servers[0]
    ?? null;
}

/**
 * "Send to conversation" from the public Artifact page (#proj-workspace:#128,
 * a signed-in reader): the one Forward dialog (ForwardComposer: recent and
 * searched destinations, several at once, joining a channel, a new DM, the
 * note, the outcome), with the Artifact's link as what it sends
 * (useArtifactLinkForwardSource: an ordinary message per conversation).
 *
 * The page is outside the server layout, so nothing is loaded for it: the
 * dialog makes a server of the reader's the current one, as the Artifact's
 * own page does when it opens in one (ArtifactPermalinkRoute's enterServer),
 * and loads that server's sidebar lists (coalesced with any load already out).
 * It starts in the server they were last in; a reader in several switches at
 * the top (ForwardServerSwitch), which makes that one current and starts the
 * dialog over in it (nothing chosen, no search). The note is a draft, so it
 * stays.
 *
 * For a reader in several, a search goes across all of them
 * (useCrossServerForwardSearch), each row naming its server; choosing a row
 * of another server keeps the current one (only the switch changes it), and
 * the message goes to that row's server (the destination's serverId).
 * Without a query, the list is the current server's recent ones, as before.
 *
 * A reader in no server (a new account, back from signing up to Fork in Raft,
 * #proj-workspace:#140) has nowhere to send it: the app's own first-server
 * flow instead (`/`, ServerRedirect's ServerSelector), nothing of its own.
 * Only when the list loaded and is empty (serverStore's record of a
 * successful load, `loadedWithin`): when it failed to load the dialog stays
 * as it was before.
 */
export function ArtifactLinkSendDialog({ link, preview, onClose }: ArtifactLinkSendDialogProps) {
  const servers = useServerStore((s) => s.servers);
  const serversLoading = useServerStore((s) => s.loading);
  const currentId = useServerStore((s) => s.current?.id ?? null);
  const channelsLoading = useChannelStore((s) => s.loading);
  const dmsLoading = useChannelStore((s) => s.dmsLoading);
  const channelActivity = useChannelStore((s) => s.channelActivity);
  const destinations = useForwardDestinations();
  const { setSelectedDestinations } = destinations;
  // The dialog borrows the app's current server to list and search its conversations. Closing it
  // puts back the server the reader was in, and the one the app remembers, unless a message went
  // to the server it is on now: then the reader may follow it there ("View in chat").
  const sentToRef = useRef(new Set<string>());
  const onSent = useCallback((serverId: string) => { sentToRef.current.add(serverId); }, []);
  // Taken at the first render, before the starting server (a layout effect) replaces it.
  const [before] = useState(() => ({
    id: useServerStore.getState().current?.id ?? null,
    lastSlug: serverPersistence.readLastServerSlug(),
  }));
  useEffect(() => {
    const { id: beforeId, lastSlug } = before;
    const sentTo = sentToRef.current;
    return () => {
      const state = useServerStore.getState();
      const nowId = state.current?.id ?? null;
      if (nowId && sentTo.has(nowId)) return;
      if (nowId !== beforeId) {
        const previous = beforeId ? state.servers.find((server) => server.id === beforeId) : undefined;
        if (previous) state.setCurrent(previous);
        else state.clearCurrent();
      }
      if (lastSlug) serverPersistence.writeLastServerSlug(lastSlug);
      else serverPersistence.clearLastServerSlug();
    };
  }, [before]);
  const source = useArtifactLinkForwardSource({ link, preview, onSent });
  const searchServers = useMemo(() => servers.map(({ id, name }) => ({ id, name })), [servers]);
  const crossServerSearch = useCrossServerForwardSearch(searchServers, currentId);
  const { reset: resetSearch } = crossServerSearch;

  // Once the reader's server list is in: the server they were last in becomes the current one
  // before the dialog paints (a layout effect), so it opens there and not first in another. A
  // switch updates the last server too, so a later reload of the list lands on the same one.
  useLayoutEffect(() => {
    if (serversLoading) return;
    const state = useServerStore.getState();
    const server = startingServer(state.servers, serverPersistence.readLastServerSlug(), state.current?.id ?? null);
    if (server && state.current?.id !== server.id) state.setCurrent(server);
  }, [serversLoading]);

  // Its conversations, as the sidebar lists them.
  useEffect(() => {
    if (!currentId) return;
    if (channelsLoading) void useChannelStore.getState().loadChannels();
    if (dmsLoading) void useChannelStore.getState().loadDMChannels();
  }, [currentId, channelsLoading, dmsLoading]);

  const switchServer = useCallback((serverId: string) => {
    const state = useServerStore.getState();
    const server = state.servers.find((candidate) => candidate.id === serverId);
    if (!server || state.current?.id === server.id) return;
    // What was chosen is the other server's: start over in this one.
    setSelectedDestinations(new Map());
    resetSearch();
    state.setCurrent(server);
  }, [setSelectedDestinations, resetSearch]);

  const options = useMemo(() => servers.map(({ id, name, slug, avatarUrl }) => ({ id, name, slug, avatarUrl })), [servers]);
  // While a send or a join is out, the server stays: both act on this one.
  const scope = useMemo(() => (options.length > 1 && currentId
    ? ({ busy }: { busy: boolean }) => (
      <ForwardServerSwitch servers={options} currentId={currentId} onChange={switchServer} disabled={busy} />
    )
    : undefined), [options, currentId, switchServer]);

  if (serversLoading) return null;
  // No server yet, as a list that loaded says: one that failed to load (GET /servers refused, `loading` false
  // all the same) never marks it loaded, and the dialog then stays, as before.
  if (servers.length === 0 && loadedWithin(bootListKey.servers, Number.POSITIVE_INFINITY)) return <Navigate to="/" />;
  // Another server is another start (key): its search and joins are that server's.
  return (
    <ForwardComposer
      key={currentId ?? "none"}
      source={source}
      destinations={destinations}
      channelActivity={channelActivity}
      scope={scope}
      // One server: the dialog's own search, as everywhere else.
      search={options.length > 1 ? crossServerSearch : undefined}
      onClose={onClose}
    />
  );
}
