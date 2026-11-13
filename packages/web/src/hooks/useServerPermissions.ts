import { getServerCapabilities, isAdminOrOwner, isOwnerRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";

export function useServerPermissions() {
  // Narrow reads: the member list and the user record are replaced on every
  // /members answer and auth refresh; only this user's role matters here.
  const currentRole = useServerStore((s) => s.current?.role);
  const userId = useAuthStore((s) => s.user?.id);
  const fallbackRole = useServerStore((s) => s.members.find((member) => member.userId === userId)?.role ?? null);
  const role: ServerRole | null = currentRole ?? fallbackRole;

  return {
    role,
    capabilities: getServerCapabilities(role),
    isAdminOrOwner: isAdminOrOwner(role),
    isOwner: isOwnerRole(role),
  };
}
