import { runtimeAuthRuntimeFor, runtimeAuthSignsInPerProvider, runtimeAuthSupports } from "@botiverse/raft-shared";
import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";

// Type only: the client module brings the API client, which this pure rule must not.
import type { RuntimeAuthView } from "./runtimeAuthClient";

/**
 * The runtime whose one sign-in a Raft runtime uses, or null when the web has
 * none to offer for it: no sign-in at all (Built-in, OpenCode), or a sign-in
 * per provider (Pi, Qwen Code), whose "signed out" may still run on a key the
 * Computer's environment holds. The rule RuntimeSignInNotice follows.
 */
export function signInRuntimeFor(runtimeId: string): RuntimeAuthRuntime | null {
  const runtime = runtimeAuthRuntimeFor(runtimeId);
  return runtime && runtimeAuthSupports(runtime, "login") && !runtimeAuthSignsInPerProvider(runtime) ? runtime : null;
}

/**
 * What a Computer's runtime-auth read says about one runtime on it.
 * `unknown`: not read yet, not readable for this viewer, not reported by the
 * Computer (an older one), or `unknown`/`unavailable` in its report.
 * `no_sign_in`: the web has no single sign-in for this runtime.
 */
export type RuntimeSignInState = "signed_in" | "signed_out" | "unknown" | "no_sign_in";

export function runtimeSignInState(view: RuntimeAuthView | null, runtimeId: string): RuntimeSignInState {
  const runtime = signInRuntimeFor(runtimeId);
  if (!runtime) return "no_sign_in";
  const kind = view?.status?.runtimes[runtime]?.kind;
  return kind === "logged_in" ? "signed_in" : kind === "logged_out" ? "signed_out" : "unknown";
}

/**
 * The runtime to start on, from candidates already in preference order:
 * the first one known to be signed in; else the first one not known to be
 * signed out (`unknown`, or one with no sign-in), which the caller preselects
 * with a notice; else null: every candidate is signed out, and nothing is
 * picked for the person.
 */
export function pickSignedInRuntime(
  candidates: readonly string[],
  stateOf: (runtimeId: string) => RuntimeSignInState,
): string | null {
  return candidates.find((id) => stateOf(id) === "signed_in")
    ?? candidates.find((id) => stateOf(id) !== "signed_out")
    ?? null;
}
