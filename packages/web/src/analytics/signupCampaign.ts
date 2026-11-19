// The campaign link that brought a sign-up (artin / Edgar, 2026-11-13,
// #triage:#363): a partner's link reaches the web app as
// `/signup?utm_source=stamp&utm_medium=public_repo&utm_campaign=owner/repo`,
// and the sign-up request passes those three values on so the server's
// `account_created` says which link it was. Kept in sessionStorage, not in
// memory, because a social sign-up leaves the page for the provider and comes
// back on a callback URL without them. Only values the registry would take
// are ever stored or sent; an email or a sentence is dropped, never rewritten.
//
// Whose campaign: the last campaign link loaded in this tab while signed out.
// A tab that already holds a session stores nothing (a signed-in person
// following a campaign link is not a sign-up source), and the stored values
// go once a sign-up or sign-in finishes here and on logout (authStore.ts).
//
// RAFT_PRIVACY_MODE: once the client config says it is on (store/privacyMode.ts)
// what was stored is removed and nothing is sent. The landing is read before
// that answer, so until then the values are stored in this tab and a sign-up
// sent that early carries them to the deployment's own server, which records
// no product events under privacy mode.

import { campaignPath, campaignToken, isRaftSiteHost, referrerHost } from "@botiverse/raft-shared";
import { isPrivacyModeOn, subscribePrivacyMode } from "../store/privacyMode";

const STORAGE_KEY = "raft.signup-campaign";
const TOKEN_KEY = "slock_access_token";

export interface SignupCampaign {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer_domain?: string;
}

// The referring site (cindyz, 2026-11-13, #proj-analytics:72b5e0e2): the
// landing site adds `ref_domain=<host>` to its sign-up / sign-in links, the
// host name of the external site the visitor came from. Kept, sent and
// dropped with the campaign values, as `referrer_domain`; the server decides
// what is stored (the registrable domain, never one of Raft's own hosts).
// raft.build and the hosts under it are not kept here either: the server
// would drop them, and a link carrying only such a `ref_domain` must not
// replace the campaign the tab already holds with a record that counts nothing.
const REFERRER_PARAM = "ref_domain";

/** Storage/URL adapter: only the valid values, each in the shape the registry stores. */
function validCampaign(read: (key: keyof SignupCampaign) => unknown): SignupCampaign {
  const text = (key: keyof SignupCampaign) => {
    const value = read(key);
    return typeof value === "string" ? value : null;
  };
  const campaign: SignupCampaign = {};
  const source = campaignToken(text("utm_source"));
  const medium = campaignToken(text("utm_medium"));
  const name = campaignPath(text("utm_campaign"));
  if (source) campaign.utm_source = source;
  if (medium) campaign.utm_medium = medium;
  if (name) campaign.utm_campaign = name;
  const referrer = referrerHost(text("referrer_domain"));
  if (referrer && !isRaftSiteHost(referrer)) campaign.referrer_domain = referrer;
  return campaign;
}

let privacySubscribed = false;

/**
 * Call once from main.tsx, right after captureLandingPage() and before the
 * first render moves the URL. A landing with campaign values replaces what
 * the tab held; one without (the social callback's load) leaves it alone,
 * and so does any load of a tab that is already signed in.
 */
export function rememberSignupCampaign(search: string = globalThis.location?.search ?? ""): void {
  if (!privacySubscribed) {
    privacySubscribed = true;
    subscribePrivacyMode((state) => {
      if (state === "on") clearSignupCampaign();
    });
  }
  if (isPrivacyModeOn() || hasSession()) return;
  const params = new URLSearchParams(search);
  const campaign = validCampaign((key) => params.get(key === "referrer_domain" ? REFERRER_PARAM : key));
  if (Object.keys(campaign).length === 0) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(campaign));
  } catch {
    // No session storage (blocked, full): this sign-up goes uncounted by campaign.
  }
}

/** A session in this browser (as publicVisits.ts reads it); unreadable storage counts as none. */
function hasSession(): boolean {
  try {
    return Boolean(globalThis.localStorage?.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

/** Spread into the sign-up request's body: the stored values, or nothing. */
export function signupCampaignBody(): SignupCampaign {
  if (isPrivacyModeOn()) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object") return {};
    return validCampaign((key) => (stored as Record<string, unknown>)[key]);
  } catch {
    return {};
  }
}

/** After a sign-up or sign-in finished: a later account in this tab is not this campaign's. */
export function clearSignupCampaign(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored either.
  }
}
