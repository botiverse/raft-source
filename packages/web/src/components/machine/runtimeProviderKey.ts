import { runtimeAuthSignsInPerProvider, runtimeAuthSupports } from "@botiverse/raft-shared";
import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";

/**
 * A runtime that has a provider's API key instead of a sign-in (Qwen Code).
 * Its status is presence only (OAR's check never says the key works), so the
 * card says "Provider configured" or "No provider configured", never signed
 * in or out, and its badge does not turn orange: a key in an agent's own
 * environment or a workspace `.env` is not seen by that check. Pi takes
 * provider keys too, but as one of its per-provider sign-ins
 * (`runtimeAuthSignsInPerProvider`), with a card of its own.
 */
export function hasProviderKey(runtime: RuntimeAuthRuntime): boolean {
  return runtimeAuthSupports(runtime, "connect_provider") && !runtimeAuthSignsInPerProvider(runtime);
}
