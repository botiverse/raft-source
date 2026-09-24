import { useEffect, useMemo, useState } from "react";
import api from "../api/client";

export type SocialAuthProviderId = "google" | "github" | "apple";

export interface AuthProvider {
  id: SocialAuthProviderId;
  label: string;
  enabled: boolean;
}

const DEFAULT_PROVIDERS: AuthProvider[] = [];

let cachedProviders: AuthProvider[] | null = null;
let providersRequest: Promise<AuthProvider[]> | null = null;

export function __resetAuthProvidersForTest(): void {
  cachedProviders = null;
  providersRequest = null;
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
      .then(({ data }) => normalizeProviders(data))
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

  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers]);

  return { providers, enabledProviders, loading };
}
