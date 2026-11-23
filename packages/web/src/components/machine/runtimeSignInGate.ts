import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";
// Type only: the client module brings the API client, which this pure rule must not.
import type { RuntimeAuthView } from "../../utils/runtimeAuthClient";

/**
 * Whether to offer Sign in for this runtime on this Computer: the Computer's
 * live sign-in state says it is signed out (`logged_out`; not signed in, not
 * `unknown` or `unavailable`, where a sign-in may not be what is missing), the
 * server says this viewer may act, and the Computer can do it from here. The
 * one rule for the runtime picker's signed-out notice and the agent status's
 * Sign in. (Setup's "can't tell" notice offers it for `unknown` by its own rule.)
 */
export function runtimeSignInOffered(view: RuntimeAuthView | null, runtime: RuntimeAuthRuntime): boolean {
  return view?.canAct === true && view.availability === "ok" && view.status?.runtimes[runtime]?.kind === "logged_out";
}
