import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseAppSumoLicenseKey, type AppSumoLicenseKey, type AppSumoTier } from "./appSumoContracts";

const licenseKeySchema = z.string().transform((value, context) => {
  const key = parseAppSumoLicenseKey(value);
  if (!key) { context.addIssue({ code: "custom", message: "Invalid license key" }); return z.NEVER; }
  return key;
});
const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const eventSchema = z.object({
  license_key: licenseKeySchema,
  prev_license_key: licenseKeySchema.optional(),
  event: z.enum(["purchase", "activate", "upgrade", "downgrade", "deactivate"]),
  license_status: z.enum(["inactive", "active", "deactivated"]),
  tier: tierSchema.optional(),
  event_timestamp: z.number().int().positive().safe(),
  created_at: z.number().int().positive().safe(),
  test: z.boolean().default(false),
  parent_license_key: licenseKeySchema.optional(),
}).superRefine((event, context) => {
  if ((event.event === "upgrade" || event.event === "downgrade") && !event.prev_license_key) {
    context.addIssue({ code: "custom", message: "Replacement event needs its previous license" });
  }
  if (event.license_key === event.prev_license_key) context.addIssue({ code: "custom", message: "License cannot replace itself" });
  if (event.event !== "purchase" && event.event !== "deactivate" && !event.tier && !event.test) {
    context.addIssue({ code: "custom", message: "Activation needs a supported tier" });
  }
});
export type AppSumoLicenseEvent = z.infer<typeof eventSchema>;
export type AppSumoProviderLicense = Readonly<{
  licenseKey: AppSumoLicenseKey;
  status: "inactive" | "active" | "deactivated";
  tier: AppSumoTier;
}>;

export function parseAppSumoWebhook(rawBody: Buffer): AppSumoLicenseEvent | null {
  if (rawBody.length > 65_536) return null;
  try {
    const parsed = eventSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** HMAC input is the exact header timestamp followed by the original body bytes. */
export function verifyAppSumoSignature(input: {
  rawBody: Buffer; timestamp: string | undefined; signature: string | undefined;
  apiKey: string; now: Date;
}): boolean {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !input.apiKey || !/^\d{10}(?:\d{3})?$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const sentAt = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
  if (!Number.isFinite(input.now.getTime()) || Math.abs(input.now.getTime() - sentAt) > 5 * 60_000) return false;
  const expected = createHmac("sha256", input.apiKey).update(timestamp).update(input.rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export type AppSumoProviderConfig = Readonly<{
  productId: string;
  apiKey: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}>;

export class AppSumoProviderError extends Error {
  constructor(readonly kind: "unavailable" | "invalid_response" | "oauth_rejected" | "rate_limited") {
    super(`AppSumo provider ${kind}`);
  }
}

export function createAppSumoProvider(config: AppSumoProviderConfig, fetcher: typeof fetch = fetch) {
  async function jsonRequest(url: URL, init: RequestInit): Promise<unknown> {
    // Do not include URLs, bodies or upstream exceptions in logs/errors: OAuth
    // resource URLs contain a documented access_token query parameter.
    try {
      const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status === 429) throw new AppSumoProviderError("rate_limited");
      if (!response.ok) throw new AppSumoProviderError(response.status === 400 || response.status === 401 || response.status === 403 ? "oauth_rejected" : "unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new AppSumoProviderError("invalid_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65_536) throw new AppSumoProviderError("invalid_response");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof AppSumoProviderError) throw error;
      throw new AppSumoProviderError("unavailable");
    }
  }
  return {
    async exchangeCode(code: string): Promise<AppSumoLicenseKey> {
      if (!code || code.length > 2048 || /\p{Cc}/u.test(code)) throw new AppSumoProviderError("oauth_rejected");
      const tokenResult = await jsonRequest(new URL("https://appsumo.com/openid/token/"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret,
          redirect_uri: config.redirectUri, code, grant_type: "authorization_code" }),
      });
      const token = z.object({ access_token: z.string().min(1).max(4096), token_type: z.string().optional() }).safeParse(tokenResult);
      if (!token.success) throw new AppSumoProviderError("invalid_response");
      const url = new URL("https://appsumo.com/openid/license_key/");
      url.searchParams.set("access_token", token.data.access_token);
      const result = z.object({ license_key: licenseKeySchema }).safeParse(await jsonRequest(url, { method: "GET" }));
      if (!result.success) throw new AppSumoProviderError("invalid_response");
      return result.data.license_key;
    },
    async getLicense(key: AppSumoLicenseKey): Promise<AppSumoProviderLicense> {
      const result = z.object({ license_key: licenseKeySchema, status: z.enum(["inactive", "active", "deactivated"]), tier: tierSchema })
        .safeParse(await jsonRequest(new URL(`https://api.licensing.appsumo.com/v2/licenses/${key}`), {
          method: "GET", headers: { "X-AppSumo-Licensing-Key": config.apiKey },
        }));
      if (!result.success || result.data.license_key !== key) throw new AppSumoProviderError("invalid_response");
      return { licenseKey: key, status: result.data.status, tier: result.data.tier };
    },
  };
}
