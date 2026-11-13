/**
 * This deployment's client config (GET /api/public/client-config): deploy
 * config every client needs, the same answer for everyone (no credentials
 * read, nothing per person or per server). Read once per page load, signed in
 * or not (a public Artifact page and the login page too), started with the
 * boot's first requests (AppShell, beside /auth/me). Each field goes to the
 * store that keeps it: `appHosts` to store/raftAppHosts.ts, `privacyMode` to
 * store/privacyMode.ts, `artifactsEmbedOrigin` to store/artifactsEmbedOrigin.ts.
 * A failed read keeps every store on its fallback for the page; nothing asks again.
 *
 * Privacy mode is the one field that must always be decided, since the page
 * holds its telemetry until it is: any answer decides it (missing = off), and
 * a failed read is off. A read that never returns is cut at
 * CLIENT_CONFIG_TIMEOUT_MS by the request itself and then counts as failed.
 * There is no separate clock that flips to off while the request may still
 * answer "on": off is reached only through an answer or a failed request.
 */
import api from "../api/client";
import { setArtifactsEmbedOrigin } from "./artifactsEmbedOrigin";
import { setRaftAppHosts } from "./raftAppHosts";
import { setPrivacyMode } from "./privacyMode";

/** The answer as the server sends it; each field is checked again by its store. */
type PublicClientConfigResponse = {
  /** Raft's own app hosts for this deployment (the server's appHosts()). */
  appHosts?: string[];
  /** RAFT_PRIVACY_MODE: present (true) only when on; older servers never send it. */
  privacyMode?: boolean;
  /** Where a public Artifact's embed page is served (`<origin>/pt_<uuid>`); null or absent: embeds are off. */
  artifactsEmbedOrigin?: string | null;
};

let clientConfigRead: Promise<void> | null = null;

/** The read's own deadline (axios `timeout`): past it the request is aborted and counts as failed (privacy off). */
export const CLIENT_CONFIG_TIMEOUT_MS = 10_000;

/** Asks for the client config the first time it is called on this page; later calls get the same read. */
export function loadClientConfig(): Promise<void> {
  clientConfigRead ??= api
    .get<PublicClientConfigResponse>("/public/client-config", { timeout: CLIENT_CONFIG_TIMEOUT_MS })
    .then(({ data }) => {
      setPrivacyMode(data?.privacyMode);
      setRaftAppHosts(data?.appHosts);
      setArtifactsEmbedOrigin(data?.artifactsEmbedOrigin);
    })
    .catch(() => {
      // Off the network, non-2xx, timed out or an odd answer: the stores keep
      // their fallbacks, and privacy mode is decided off so held telemetry goes.
      setPrivacyMode(false);
    });
  return clientConfigRead;
}

export function resetClientConfigForTests(): void {
  clientConfigRead = null;
}
