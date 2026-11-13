import { signedInPersonId, useAuthStore } from "./authStore";
import { resetChannelAccessLoss } from "./channelAccessLoss";
import { useMessageStore } from "./messageStore";

/**
 * Who is signed in has one source, the auth store. The messages store keeps a
 * copy to read replies for that person (receiver-private ingress); it takes it
 * the moment the auth store changes, before anything renders, so no request
 * can leave before it is set. Until /auth/me answers, that is the person the
 * stored token belongs to (signedInPersonId): a server link opened from the
 * device asks for its channel's first page in that window.
 */
export function followSignedInUser(): () => void {
  let person = signedInPersonId(useAuthStore.getState());
  const apply = () => {
    const next = signedInPersonId(useAuthStore.getState());
    // The channels the last person was removed from are theirs, not the next person's.
    if (next !== person) resetChannelAccessLoss();
    person = next;
    useMessageStore.getState().setCurrentUserId(next);
  };
  apply();
  return useAuthStore.subscribe(apply);
}
