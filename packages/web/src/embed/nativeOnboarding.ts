export const NATIVE_ONBOARDING_CONTRACT_VERSION = "raft-onboarding-v1" as const;

const NATIVE_ONBOARDING_PATH = /^\/s\/[^/]+\/onboarding$/;

/**
 * The app-only setup surface, `/s/:slug/onboarding` (App.tsx renders it only
 * with a generation). One place for the path: the setup events' `native_host`
 * (analytics/serverSetup.ts) reads it too. With `slug`, that server's path
 * exactly (App.tsx's route); without, any server's (the analytics, which has
 * no routed server).
 */
export function isNativeOnboardingPath(pathname: string, slug?: string): boolean {
  return slug === undefined ? NATIVE_ONBOARDING_PATH.test(pathname) : pathname === `/s/${slug}/onboarding`;
}

const GENERATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Echo only a bounded opaque generation minted by the Native host. Missing or
 * malformed input fails closed: Web may render setup, but it cannot wake a host
 * whose current WebView identity it cannot prove.
 */
export function readNativeOnboardingGeneration(search: string): string | null {
  const generation = new URLSearchParams(search).get("generation");
  return generation && GENERATION_PATTERN.test(generation) ? generation : null;
}
