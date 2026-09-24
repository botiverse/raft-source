/**
 * A joint channel can project the same global user through multiple servers.
 * Task ownership is keyed by that global id, so the picker must expose one
 * logical candidate rather than one row per membership provenance.
 *
 * Preserve the first occurrence of each logical id in the option ordering, but
 * choose that id's representative from a stable projection/profile key. Joint
 * projection query order is not an identity property: [A, B] and [B, A] must
 * render the same label and avatar for the same global actor.
 */
type TaskAssigneeMember = {
  id: string;
  serverId?: string;
  name?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  gravatarHash?: string;
};

function representativeKey(member: TaskAssigneeMember): string {
  return JSON.stringify([
    member.serverId ?? "",
    member.displayName ?? "",
    member.name ?? "",
    member.avatarUrl ?? "",
    member.gravatarHash ?? "",
  ]);
}

export function dedupeTaskAssigneeMembers<T extends TaskAssigneeMember>(members: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const member of members) {
    const current = byId.get(member.id);
    if (!current || representativeKey(member) < representativeKey(current)) {
      byId.set(member.id, member);
    }
  }
  return [...byId.values()];
}
