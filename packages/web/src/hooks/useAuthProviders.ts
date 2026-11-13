import { useEffect, useMemo, useState } from "react";
import api from "../api/client";

export type SocialAuthProviderId = "google" | "github" | "apple";

export interface AuthProvider {
  id: SocialAuthProviderId;
  label: string;
  enabled: boolean;
}

const DEFAULT_PROVIDERS: AuthProvider[] = [];

/**
 * How many sign-in buttons the deployment showed last time, on this device:
 * the space a sign-in page keeps for them while `/auth/providers` is on its
 * way, so nothing moves when they arrive. Never seen here: every provider
 * Raft has (Google, GitHub, Apple), what production shows.
 */
export const SIGN_IN_PROVIDER_COUNT_STORAGE = "raft:auth-provider-count:v1";
const ALL_PROVIDER_COUNT = 3;

function rememberedProviderCount(): number {
  try {
    const raw = localStorage.getItem(SIGN_IN_PROVIDER_COUNT_STORAGE);
    const stored = raw === null || raw === "" ? Number.NaN : Number(raw);
    return Number.isInteger(stored) && stored >= 0 && stored <= ALL_PROVIDER_COUNT ? stored : ALL_PROVIDER_COUNT;
  } catch {
    return ALL_PROVIDER_COUNT;
  }
}

function rememberProviderCount(providers: AuthProvider[]): void {
  try {
    localStorage.setItem(SIGN_IN_PROVIDER_COUNT_STORAGE, String(providers.filter((provider) => provider.enabled).length));
  } catch {
    // Private mode, quota: the next visit reserves the default.
  }
}

let cachedProviders: AuthProvider[] | null = null;
let providersRequest: Promise<AuthProvider[]> | null = null;
/** Some Server offers single sign-on (RFC 083): the sign-in page shows "Continue with SSO". */
let ssoOffered = false;
/** The source-available deployment is at the Raft License's user limit: the sign-up page says so (signing up still works). */
let deploymentUserLimitReached = false;

export function __resetAuthProvidersForTest(): void {
  cachedProviders = null;
  providersRequest = null;
  ssoOffered = false;
  deploymentUserLimitReached = false;
}

function isSocialAuthProviderId(value: unknown): value is SocialAuthProviderId {
  return value === "google" || value === "github" || value === "apple";
}

function normalizeProviders(data: unknown): AuthProvider[] {
  if (!data || typeof data !== "object" || !("providers" in data) || !Array.isArray(data.providers)) {
    return DEFAULT_PROVIDERS;
  }

  return data.providers
    .filter((provider): provider is { id: SocialAuthProviderId; label?: unknown; enabled?: unknown } =>
      !!provider && typeof provider === "object" && isSocialAuthProviderId((provider as { id?: unknown }).id)
    )
    .map((provider) => ({
      id: provider.id,
      label: typeof provider.label === "string" ? provider.label : provider.id,
      enabled: !!provider.enabled,
    }));
}

async function fetchAuthProviders(): Promise<AuthProvider[]> {
  if (cachedProviders) return cachedProviders;
  if (!providersRequest) {
    providersRequest = api.get("/auth/providers")
      .then(({ data }) => {
        ssoOffered = (data as { sso?: unknown } | null)?.sso === true;
        deploymentUserLimitReached = (data as { deploymentUserLimitReached?: unknown } | null)?.deploymentUserLimitReached === true;
        const providers = normalizeProviders(data);
        rememberProviderCount(providers);
        return providers;
      })
      .catch(() => DEFAULT_PROVIDERS)
      .finally(() => {
        providersRequest = null;
      });
  }

  cachedProviders = await providersRequest;
  return cachedProviders;
}

export function useAuthProviders() {
  const [providers, setProviders] = useState<AuthProvider[]>(cachedProviders ?? DEFAULT_PROVIDERS);
  const [loading, setLoading] = useState(!cachedProviders);
  const [expectedCount] = useState(rememberedProviderCount);

  useEffect(() => {
    let cancelled = false;

    async function loadProviders() {
      try {
        const data = await fetchAuthProviders();
        if (!cancelled) {
          setProviders(data);
        }
      } catch {
        if (!cancelled) setProviders(DEFAULT_PROVIDERS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProviders();

    return () => {
      cancelled = true;
    };
  }, []);

  // Desktop shell now runs OAuth through the native PKCE + loopback flow, and the
  // backend supporting it is live in production (PR #7450, verified deployed
  // 2026-09-15), so the 2026-09-10 desktop hide is removed — social providers show
  // in every shell.
  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers],
  );

  // Read after the load settles (the module value is set before `loading` turns false).
  return {
    providers,
    enabledProviders,
    loading,
    expectedCount,
    ssoOffered: !loading && ssoOffered,
    deploymentUserLimitReached: !loading && deploymentUserLimitReached,
  };
}
