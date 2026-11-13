import type { LoginProvider, ProviderAuthStatus } from "@botiverse/oar";
import {
  RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT,
  isRuntimeAuthProviderId,
  runtimeAuthProviderSchema,
  type RuntimeAuthProvider,
  type RuntimeAuthProviderKeyEntry,
  type RuntimeAuthProviderOAuthFlow,
  type RuntimeAuthSignedInProvider,
} from "@botiverse/raft-shared";

/**
 * The Pi runtime's sign-ins from the web (docs/contracts/runtime-auth.md):
 * every provider pi's own `/login` lists (OAR's
 * `createPiProviderAuth().loginProviders()`), each signed in on its own in the
 * Computer's Pi `auth.json`. Raft keeps no list of providers; this file only
 * says how each OAuth flow pi has runs without a browser on the Computer, and
 * answers pi's own questions inside a flow for the person (xxchan: never ask
 * which mode).
 *
 * These are pi internals (option ids, prompt kinds): the daemon tests run
 * every flow pi lists against this table, so a pi upgrade that adds a flow or
 * renames an option fails there, not on someone's sign-in.
 */

/**
 * How each OAuth flow pi 1.5 has runs from the web, and what the daemon
 * answers to pi's questions in it:
 * - `select`: the option id picked when pi asks which login mode (the
 *   headless one: Anthropic's copy-code, OpenAI Codex's and Radius's device
 *   code);
 * - `blankText`: GitHub Copilot asks for a GitHub Enterprise domain first;
 *   blank means github.com (Enterprise is not offered from the web).
 * OpenAI ("Sign in with ChatGPT") and OpenRouter have one mode: pi waits for
 * its localhost callback or a pasted address, and the person pastes it.
 * A provider pi lists that is not here is `computer_only`: shown, with why it
 * cannot be signed in from the web, never started.
 */
export const PI_OAUTH_FLOWS: Readonly<Record<string, { flow: Exclude<RuntimeAuthProviderOAuthFlow, "computer_only">; select?: string; blankText?: true }>> = {
  anthropic: { flow: "paste_code", select: "copy_code" },
  "openai-codex": { flow: "device_code", select: "device_code" },
  openai: { flow: "paste_address" },
  openrouter: { flow: "paste_address" },
  "github-copilot": { flow: "device_code", blankText: true },
  "kimi-coding": { flow: "device_code" },
  xai: { flow: "device_code" },
  meta: { flow: "device_code" },
  radius: { flow: "device_code", select: "device-code" },
};

export function piOAuthFlow(providerId: string): RuntimeAuthProviderOAuthFlow {
  return Object.hasOwn(PI_OAUTH_FLOWS, providerId) ? PI_OAUTH_FLOWS[providerId]!.flow : "computer_only";
}

/**
 * The providers whose API-key login asks more than the key (pi 1.5): Amazon
 * Bedrock and Google Vertex ask which credential first, the Cloudflare
 * providers an account (and gateway) id after it. OAR's `setApiKey` refuses
 * them without storing anything; the web shows them, saying so.
 */
export const PI_KEY_PROVIDERS_ASKING_MORE: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "google-vertex",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
]);

export function piKeyEntry(provider: LoginProvider): RuntimeAuthProviderKeyEntry | null {
  const method = provider.methods.find((candidate) => candidate.method === "api_key");
  if (!method || method.method !== "api_key") return null;
  if (method.ambient) return "outside";
  return PI_KEY_PROVIDERS_ASKING_MORE.has(provider.providerId) ? "more_fields" : "key";
}

/**
 * A name pi gives (its registry, or a custom provider's in `models.json`) as
 * the web may show it: control characters dropped, trimmed, at most 80
 * characters; the provider id when nothing is left. Per row, so one odd name
 * never costs the whole Pi status its other providers.
 */
export function piProviderLabel(name: string | undefined, providerId: string): string {
  const label = (name ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().slice(0, 80).trim();
  return label || providerId.slice(0, 80);
}

/**
 * The stored sign-ins, as the status report carries them: provider id, pi's
 * name for it, OAuth or key. From a read that resolves nothing
 * (`listProviders({resolve: false})`: no OAuth refresh, no key command run).
 */
export function piSignedInProviders(
  stored: readonly ProviderAuthStatus[],
  providers: readonly LoginProvider[],
): RuntimeAuthSignedInProvider[] {
  const names = new Map(providers.map((provider) => [provider.providerId, provider.name]));
  const rows: RuntimeAuthSignedInProvider[] = [];
  for (const entry of stored) {
    if (!entry.configured || !isRuntimeAuthProviderId(entry.providerId)) continue;
    const label = piProviderLabel(names.get(entry.providerId), entry.providerId);
    const method = entry.method === "oauth" ? "oauth" : "api_key";
    rows.push({
      id: entry.providerId,
      label,
      method,
      ...(method === "oauth" ? { subscription: entry.subscription === true } : {}),
    });
  }
  return rows.slice(0, RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT);
}

/**
 * One provider of pi's `/login` list as the web chooses it: its name, its
 * OAuth sign-in (with how it runs from here) and its key, and whether a
 * sign-in is stored for it. Null for an entry the web could not show.
 */
export function piWebProvider(provider: LoginProvider, stored: ProviderAuthStatus | undefined): RuntimeAuthProvider | null {
  if (!isRuntimeAuthProviderId(provider.providerId)) return null;
  const oauth = provider.methods.find((method) => method.method === "oauth");
  const apiKey = provider.methods.find((method) => method.method === "api_key");
  const keyEntry = piKeyEntry(provider);
  const configured = stored?.configured === true;
  const candidate: RuntimeAuthProvider = {
    id: provider.providerId,
    label: piProviderLabel(provider.name, provider.providerId),
    configured,
    endpoint: { kind: "fixed" },
    needsModelIds: false,
    signIn: {
      ...(oauth && oauth.method === "oauth"
        ? { oauth: { label: piProviderLabel(oauth.name, provider.providerId), subscription: oauth.subscription, flow: piOAuthFlow(provider.providerId) } }
        : {}),
      ...(apiKey && keyEntry ? { apiKey: { label: piProviderLabel(apiKey.name, provider.providerId), entry: keyEntry } } : {}),
      ...(configured && stored?.method ? { stored: stored.method } : {}),
    },
  };
  const parsed = runtimeAuthProviderSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a pi login ended without a sign-in, from its error. The message is
 * only matched here, never relayed, logged or traced.
 */
export function piLoginFailureReason(error: unknown): "timed_out" | "rejected" | "process_failed" {
  const message = error instanceof Error ? error.message : "";
  if (/expired|timed? ?out/iu.test(message)) return "timed_out";
  if (/denied|declined|rejected|access_denied|invalid_grant|state mismatch/iu.test(message)) return "rejected";
  return "process_failed";
}
