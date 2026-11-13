import { setArtifactSessionScope } from "../../apps/artifacts";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";

// Workspace Artifacts S5: what this session saved as Artifacts (the saver's
// own "Saved as Artifact" line until the message brings it) belongs to the
// signed-in server and person. Only the channel panel loads this (it reads
// the auth store, which needs the browser).

/** The server and person what this session saved as Artifacts belongs to; a switch forgets it. */
export function artifactSessionScope(): string | null {
  const serverId = useServerStore.getState().current?.id;
  const userId = useAuthStore.getState().user?.id;
  return serverId && userId ? `${serverId}:${userId}` : null;
}

/** Keeps the app's session scope on the signed-in server and person, for the life of the page. */
export function installArtifactSessionScope(): () => void {
  const update = () => setArtifactSessionScope(artifactSessionScope());
  update();
  const offServer = useServerStore.subscribe(update);
  const offAuth = useAuthStore.subscribe(update);
  return () => { offServer(); offAuth(); };
}
