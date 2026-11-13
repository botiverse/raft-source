import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "../authStore";
import { useServerStore } from "../serverStore";
import { requestActors } from "./actorResolve";
import type { ActorRef } from "./actorResolve";
import { actorKey, actorsTable } from "./index";
import type { ActorRow } from "./index";

const subscribeNothing = () => () => {};

/**
 * The actors-table row for a sender no live roster resolved, re-rendering
 * when the resolver fills it. Pass null when the roster already has the
 * sender: nothing is subscribed or requested then.
 */
export function useActorFallback(ref: ActorRef | null): ActorRow | undefined {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const kind = ref?.kind ?? null;
  const id = ref?.id ?? null;
  const active = Boolean(userId && serverId && kind && id);
  const subscribe = useCallback(
    (listener: () => void) => (active
      ? actorsTable.subscribe({ userId: userId!, serverId: serverId! }, listener)
      : () => {}),
    [active, userId, serverId],
  );
  const read = () => (active
    ? actorsTable.get({ userId: userId!, serverId: serverId! }, actorKey(kind!, id!))
    : undefined);
  const row = useSyncExternalStore(active ? subscribe : subscribeNothing, read, read);
  const missing = active && !row;
  useEffect(() => {
    if (!missing) return;
    requestActors({ userId: userId!, serverId: serverId! }, [{ kind: kind!, id: id! }]);
  }, [missing, userId, serverId, kind, id]);
  return row;
}
