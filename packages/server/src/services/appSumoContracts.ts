import { randomUUID } from "node:crypto";
/** AppSumo-issued opaque license identity; normalized only at the provider boundary. */
declare const appSumoLicenseKeyBrand: unique symbol;
export type AppSumoLicenseKey = string & { readonly [appSumoLicenseKeyBrand]: true };
export type AppSumoTier = 1 | 2 | 3 | 4;

export function parseAppSumoLicenseKey(value: unknown): AppSumoLicenseKey | null {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null;
  return value.toLowerCase() as AppSumoLicenseKey;
}

/** Public correlation identifier; it is not the secret claim cookie. */
declare const appSumoClaimIdBrand: unique symbol;
export type AppSumoClaimId = string & { readonly [appSumoClaimIdBrand]: true };
export function parseAppSumoClaimId(value: unknown): AppSumoClaimId | null {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null;
  return value.toLowerCase() as AppSumoClaimId;
}
export function createAppSumoClaimId(): AppSumoClaimId { return parseAppSumoClaimId(randomUUID())!; }
