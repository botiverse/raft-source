import { useMemo } from "react";

import { useServerStore } from "../../store/serverStore";

/**
 * The server a `server` home is, as the Artifact copy names it ("Everyone in
 * Northwind Labs", #proj-workspace:#84; agents read "everyone in <server>"
 * too): the message values `named` ("yes" when there is a name) and `server`
 * (the name), for the messages that choose between "Everyone in {server}"
 * and the generic "Everyone in this server". A type, not an interface, so
 * message values take it as it is.
 */
export type ArtifactServerName = {
  named: "yes" | "no";
  server: string;
};

export function artifactServerName(name: string | null | undefined): ArtifactServerName {
  return name ? { named: "yes", server: name } : { named: "no", server: "" };
}

/**
 * The current server's name: every read the app makes carries the current
 * server (the canonical link's page enters the Artifact's own server first),
 * and another server's Artifact reaches a reader only while anyone with the
 * link may open it, so a `server` home on screen is always the current
 * server's. No current server (none entered yet): the generic wording.
 */
export function useArtifactServerName(): ArtifactServerName {
  const name = useServerStore((s) => s.current?.name ?? null);
  return useMemo(() => artifactServerName(name), [name]);
}

/** The same, read once outside render (a toast once a save is in). */
export function currentArtifactServerName(): ArtifactServerName {
  return artifactServerName(useServerStore.getState().current?.name);
}
