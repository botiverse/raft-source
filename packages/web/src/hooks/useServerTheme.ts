import { useServerStore } from "../store/serverStore";
import type { Server } from "../store/serverStore";
import { RAFT_LOOK, readCachedServerTheme, serverThemeLook } from "../theme/serverTheme";
import type { ServerThemeLook } from "../theme/serverTheme";

/** A server's look as this device last knew it, when its record has none yet. */
export function serverLookOrCached(server: Server, plan?: string | null): ServerThemeLook {
  return serverThemeLook(server, plan) ?? readCachedServerTheme(server.id) ?? RAFT_LOOK;
}

/** The current server's look, its plan read billing first (the paywalls' reading). */
export function useCurrentServerLook(): ServerThemeLook | null {
  const current = useServerStore((state) => state.current);
  const plan = useServerStore((state) => state.billing?.plan || state.current?.plan);
  return current ? serverLookOrCached(current, plan) : null;
}
