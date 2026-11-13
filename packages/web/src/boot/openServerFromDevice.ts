/**
 * A link to a server opens it from the server list kept on the device
 * (store/localTables) while GET /servers is still on its way, so the
 * conversation and its messages are asked for in the same round trip as the
 * list instead of after it (docs/frontend/boot-requests.md). The list then
 * confirms the server, or it is dropped as a removal is (serverStore).
 * Nothing is written on its behalf before that.
 */
import { hasChatSurfaces } from "../embed";
import { isAccessTokenExpired } from "../utils/hostAccessTokenSync";
import { serverSlugOfPath } from "../utils/serverSlugOfPath";
import { serversTable } from "../store/localTables";
import { localTableSession } from "../store/localTables/storeWriters";
import { preloadServerRoute } from "../store/preloadServerRoute";
import { useServerStore } from "../store/serverStore";


export async function openServerFromDevice(
  location: Pick<Location, "pathname" | "search">,
  hydrated: Promise<void>,
): Promise<boolean> {
  const slug = serverSlugOfPath(location.pathname);
  if (!slug || !hasChatSurfaces()) return false;
  await hydrated;
  // The person the stored session belongs to: /auth/me has not answered yet.
  const userId = localTableSession();
  if (!userId) return false;
  // An expired token would send every early request into the refresh first;
  // /auth/me refreshes it and the boot goes the usual way (as requestServerListEarly).
  const token = localStorage.getItem("slock_access_token");
  if (!token || isAccessTokenExpired(token, Date.now())) return false;
  const scope = { userId };
  // `fresh` means the network's list already arrived: nothing to win.
  if (serversTable.freshness(scope) !== "local") return false;
  const server = serversTable.list(scope).find((row) => row.slug === slug);
  if (!server || !useServerStore.getState().setCurrentFromDevice(server)) return false;
  preloadServerRoute(location.pathname, location.search, userId);
  return true;
}
