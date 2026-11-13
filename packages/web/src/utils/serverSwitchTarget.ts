// Which server a host's switch-server command lands on (task #139: the desktop
// app's ⌘1…⌘9 and ⌘⇧[ / ⌘⇧]). Pure, so it is testable without the web stores;
// host/hostCommands.ts does the wiring.

interface SwitchableServer {
  id: string;
  slug: string;
}

/**
 * The server a request lands on, or null when it is a no-op (unknown id, the
 * current server, fewer than two servers to step through). Stepping wraps, and
 * with no current server it starts from the first / last.
 */
export function resolveServerSwitch<T extends SwitchableServer>(
  servers: readonly T[],
  currentId: string | null,
  request: unknown,
): T | null {
  if (!request || typeof request !== "object") return null;
  const { serverId, delta } = request as { serverId?: unknown; delta?: unknown };
  if (typeof serverId === "string") {
    const target = servers.find((s) => s.id === serverId);
    return target && target.id !== currentId ? target : null;
  }
  if ((delta !== 1 && delta !== -1) || servers.length === 0) return null;
  const at = servers.findIndex((s) => s.id === currentId);
  if (at === -1) return delta === 1 ? servers[0] : servers[servers.length - 1];
  if (servers.length < 2) return null;
  return servers[(at + delta + servers.length) % servers.length];
}
