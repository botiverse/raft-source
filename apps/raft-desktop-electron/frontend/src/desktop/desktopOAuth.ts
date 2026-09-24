// Desktop social login (renderer half).
//
// Runs the server's existing PKCE + one-time-handoff flow, bridged through the
// native loopback (see src/app/oauthLoopback.ts). The renderer owns PKCE and
// the two HTTPS calls (/start, /complete); the main process only runs the
// loopback + opens the system browser and hands back the one-time code. Tokens
// are returned ONLY by /complete over HTTPS — never through the browser.

import api from "@web/api/client";
import { useAuthStore } from "@web/store/authStore";
import { desktopNotice } from "./desktopNotice";

const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub", apple: "Apple" };
function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

interface OAuthBridge {
  arm: (nonce: string) => Promise<{ port: number; token: string }>;
  openAndAwait: (authorizationUrl: string, token: string) => Promise<{ code: string }>;
  cancel: (token: string) => void;
  onStart: (handler: (provider: string) => void) => () => void;
}

function oauthBridge(): OAuthBridge | undefined {
  return (globalThis as { raftDesktop?: { oauth?: OAuthBridge } }).raftDesktop?.oauth;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

interface StartResponse {
  authorizationUrl: string;
}
interface CompleteResponse {
  accessToken: string;
  refreshToken: string;
}

function httpStatus(err: unknown): number | undefined {
  const response = (err as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : undefined;
}

let inFlight = false;

export async function runDesktopOAuth(provider: string): Promise<void> {
  const bridge = oauthBridge();
  if (!bridge || inFlight) return;
  inFlight = true;
  let token: string | undefined;
  try {
    const codeVerifier = randomBase64Url(32); // ~43 base64url chars
    const codeChallenge = await pkceChallenge(codeVerifier);
    const desktopNonce = randomBase64Url(24); // ~32 chars, within the server's [A-Za-z0-9_-]{16,256}

    const armed = await bridge.arm(desktopNonce);
    token = armed.token;
    const { port } = armed;
    const returnUri = `http://127.0.0.1:${port}/auth/done#state=${desktopNonce}`;

    const start = await api.post<StartResponse>("/auth/mobile/oauth/start", {
      provider,
      mode: "login",
      returnUri,
      codeChallenge,
    });

    const { code } = await bridge.openAndAwait(start.data.authorizationUrl, token);

    let complete;
    try {
      complete = await api.post<CompleteResponse>("/auth/mobile/oauth/complete", { code, codeVerifier });
    } catch (err) {
      // 422 LEGAL_ACCEPTANCE_REQUIRED / 409 TERMS_CHANGED — only when the social
      // profile has no existing account and a new one would be created. We don't
      // yet have a desktop terms-consent dialog, so surface it honestly rather
      // than auto-accepting on the user's behalf.
      const status = httpStatus(err);
      if (status === 422 || status === 409) {
        // No desktop terms-consent dialog yet, so we can't create a brand-new
        // account from social login here. Surface it as a clear in-app notice
        // (not a raw browser alert) with the workable path, instead of a dead end.
        // TODO: in-app ToS acceptance so desktop-first social sign-up completes.
        desktopNotice.info(
          `To create a new account with ${providerLabel(provider)}, sign up with email and password first — then ${providerLabel(provider)} sign-in works here.`,
          { dismissible: true },
        );
        return;
      }
      throw err;
    }

    // Tokens only ever arrive here, over HTTPS. Hand them to the shared store.
    useAuthStore.getState().setTokens(complete.data.accessToken, complete.data.refreshToken);
    await useAuthStore.getState().loadUser();
  } catch (err) {
    // Previously this failed to the console only, so a failed social login did
    // nothing on screen — the most likely first-run dead end. Surface it.
    console.error("[raft-desktop] desktop OAuth failed", err);
    if (token) bridge.cancel(token);
    desktopNotice.error(
      `Couldn't complete ${providerLabel(provider)} sign-in — please try again, or sign in with email and password.`,
      { dismissible: true },
    );
  } finally {
    inFlight = false;
  }
}

// Subscribe to social-login clicks (the shell intercepts the web start URL and
// forwards the provider here). Call once at startup.
export function installDesktopOAuth(): void {
  const bridge = oauthBridge();
  if (!bridge) return;
  bridge.onStart((provider) => {
    void runDesktopOAuth(provider);
  });
}
