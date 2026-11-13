// `user:profile-updated`: a person changed their name or avatar. Patch that
// one member in place (the member list is not re-read, and every other member
// keeps its object, so only that person's avatars re-render), and the signed-in
// user's own record when it is them, so their other tabs follow.
import { userProfileUpdatedEventSchema } from "@botiverse/raft-shared";
import type { UserProfileUpdatedEvent } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";

// The event's deprecated `gravatarHash` (always "" now; an older server's
// hash) is parsed for compatibility and ignored.
type Profile = Pick<UserProfileUpdatedEvent, "name" | "displayName" | "avatarUrl">;

function sameProfile(current: Profile, next: Profile): boolean {
  return current.name === next.name && current.displayName === next.displayName
    && current.avatarUrl === next.avatarUrl;
}

export function applyUserProfileUpdatedEvent(payload: unknown): void {
  const parsed = userProfileUpdatedEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const { serverId, userId, name, displayName, avatarUrl } = parsed.data;
  const profile: Profile = { name, displayName, avatarUrl };

  const { current, members } = useServerStore.getState();
  const index = current?.id === serverId ? members.findIndex((member) => member.userId === userId) : -1;
  const member = index >= 0 ? members[index] : undefined;
  if (member && !sameProfile(member, profile)) {
    const next = members.slice();
    next[index] = { ...member, ...profile };
    useServerStore.setState({ members: next });
  }

  // authStore reads localStorage when it loads; the bridge must load without it
  // (socketBridgeNodeLoad.test.ts), so it is reached only when an event comes.
  void import("./authStore").then(({ useAuthStore }) => {
    const user = useAuthStore.getState().user;
    if (user?.id === userId && !sameProfile(user, profile)) useAuthStore.setState({ user: { ...user, ...profile } });
  }, () => {});
}
