import type { DesktopWebPreviewRaftSignInRequest } from "@botiverse/raft-shared";

import api from "../../api/client";
import { isVisibleOAuthScope } from "../../lib/oauthScopePresentation";

/**
 * How long the sheet's approving button takes no press, counted from when it
 * can first be pressed (after the setup's lookups, not from when the sheet
 * appears) and again from each time the window regains the focus: a sheet a
 * page raised at the moment of a click or a key press meant for the page, or
 * for another window, takes no approval from it.
 */
export const APPROVE_AFTER_MS = 1000;

/** A sign-in request from the built-in browser that the sheet may show. */
export interface DesktopBrowserSignInRequest {
  requestId: string;
  /** The setup address's query as Raft's server wrote it: what the consent reads. */
  setupSearch: string;
  /** The host the answer will be sent to (ASCII, as the address bar would show it), with its port if it names one. */
  returnHost: string;
  /** The App asked for, the return address the request names (as the server wrote it) and its scopes: what the App is looked up with. */
  clientId: string;
  returnUrl: string;
  scope: string;
}

/**
 * The shell's request as the sheet shows it, or null: one the sheet refuses
 * to show. The shell has already had Raft's server accept the request and
 * checked where its answer goes; this is the sheet's own rule, that it shows
 * no text a page chose. Every requested scope must be one Raft has its own
 * words for (an unknown one would be printed as the page wrote it), and the
 * return address must be an http(s) one whose host can be named.
 */
export function desktopBrowserSignInRequest(value: DesktopWebPreviewRaftSignInRequest | null | undefined): DesktopBrowserSignInRequest | null {
  if (!value || typeof value.requestId !== "string" || !value.requestId || typeof value.setupSearch !== "string") return null;
  const params = new URLSearchParams(value.setupSearch);
  const clientId = params.get("client_id")?.trim();
  if (!clientId) return null;
  const scopes = (params.get("scope") || "openid profile").split(/\s+/).filter(Boolean);
  if (!scopes.every(isVisibleOAuthScope)) return null;
  const returnTo = params.get("return_to") ?? "";
  let returnUrl: URL;
  try {
    returnUrl = new URL(returnTo);
  } catch {
    return null;
  }
  if ((returnUrl.protocol !== "https:" && returnUrl.protocol !== "http:") || !returnUrl.host) return null;
  return { requestId: value.requestId, setupSearch: value.setupSearch, returnHost: returnUrl.host, clientId, returnUrl: returnTo, scope: scopes.join(" ") };
}

/**
 * Whether the request names the App's own return address: the one the App is
 * registered with, as some Server's lookup gives it, character for character
 * (the server compares them the same way when it issues the code). A page
 * anywhere can ask with any App's `client_id` and a return address of its
 * own; the shell only knows the page is on that address's site. Such a
 * request is never shown: the sheet would put the App's name and icon over a
 * sign-in that is not the App's.
 */
export function isRegisteredReturnAddress(returnUrl: string, registered: readonly unknown[]): boolean {
  return returnUrl.length > 0 && registered.some((address) => address === returnUrl);
}

/**
 * The return address the App is registered with, on each of these Servers
 * where the lookup answers for this person (GET /oauth/clients/lookup, the
 * setup's own). A Server that refuses or fails gives none.
 */
export async function lookUpRegisteredReturnAddresses(
  request: Pick<DesktopBrowserSignInRequest, "clientId" | "scope">,
  serverIds: readonly string[],
): Promise<unknown[]> {
  const answers = await Promise.all(serverIds.map((serverId) => (
    api.get("/oauth/clients/lookup", { params: { client_id: request.clientId, server_id: serverId, scope: request.scope } })
      .then((response) => (response.data as { returnUrl?: unknown } | null)?.returnUrl)
      .catch(() => undefined)
  )));
  return answers.filter((address) => typeof address === "string");
}
