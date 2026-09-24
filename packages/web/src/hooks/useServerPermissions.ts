import { getServerCapabilities, isAdminOrOwner, isOwnerRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";

export function useServerPermissions() {
  const currentRole = useServerStore((s) => s.current?.role);
  const members = useServerStore((s) => s.members);
  const user = useAuthStore((s) => s.user);

  const fallbackRole = members.find((member) => member.userId === user?.id)?.role ?? null;
  const role: ServerRole | null = currentRole ?? fallbackRole;

  return {
    role,
    capabilities: getServerCapabilities(role),
    isAdminOrOwner: isAdminOrOwner(role),
    isOwner: isOwnerRole(role),
  };
}
