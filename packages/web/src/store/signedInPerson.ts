// The signed-in person's id, for apps (scripts/ci/check-app-module-boundaries.ts): an app reads
// who is signed in through here, never authStore itself (the session's tokens and the auth actions
// stay core's). null with no one signed in.
import { signedInPersonId, useAuthStore } from "./authStore";

export function useSignedInPersonId(): string | null {
  return useAuthStore((s) => signedInPersonId(s));
}
