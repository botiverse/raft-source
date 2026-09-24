export const NATIVE_ONBOARDING_CONTRACT_VERSION = "raft-onboarding-v1" as const;

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
