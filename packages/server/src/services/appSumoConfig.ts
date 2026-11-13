import type { AppSumoProviderConfig } from "./appSumoProvider";

export type AppSumoConfig = AppSumoProviderConfig & { appOrigin: string };
/** No registration or activation without an explicit product and provider secret. */
export function getAppSumoConfig(env: NodeJS.ProcessEnv = process.env): AppSumoConfig | null {
  const productId = env.APPSUMO_PRODUCT_ID?.trim();
  const apiKey = env.APPSUMO_API_KEY;
  const redirectUri = env.APPSUMO_REDIRECT_URI;
  if (!productId || !/^[A-Za-z0-9_-]{1,80}$/.test(productId) || !apiKey || !redirectUri || !env.APP_URL) return null;
  try {
    const callback = new URL(redirectUri);
    const app = new URL(env.APP_URL);
    if (callback.protocol !== "https:" || app.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash
      || callback.pathname !== "/api/appsumo/oauth/callback" || app.username || app.password) return null;
    return { productId, apiKey, redirectUri, appOrigin: app.origin,
      clientId: env.APPSUMO_CLIENT_ID ?? "", clientSecret: env.APPSUMO_CLIENT_SECRET ?? "" };
  } catch { return null; }
}
