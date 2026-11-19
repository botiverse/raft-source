import { campaignPath, campaignToken } from "@botiverse/raft-shared";
import { signupReferrerSite } from "./signupReferrerSite";

export interface SignupCampaign {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer_domain?: string;
}

// The campaign link that brought a web sign-up (artin / Edgar, 2026-11-13,
// #triage:#363), as the web sends it in the sign-up body. A value that is not
// a campaign token (or, for the campaign, an owner/repo path) is left out, so
// it can neither refuse the request nor reject the event. Never stored
// elsewhere, never logged.
// referrer_domain (cindyz, 2026-11-13, #proj-analytics:72b5e0e2): the site the
// visitor was on before Raft's landing site, on the same terms; kept as its
// registrable domain and never when it is one of Raft's own hosts.
// The one set of rules for these four values: account_created (routes/auth.ts)
// and desktop_download_requested (desktopDownloadProductEvents.ts) both read
// them through here. Only plain strings are read; anything else is left out.
export function parseSignupCampaign(raw: unknown): SignupCampaign {
  const body: Record<string, unknown> = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const campaign: SignupCampaign = {};
  const source = campaignToken(text(body.utm_source));
  const medium = campaignToken(text(body.utm_medium));
  const name = campaignPath(text(body.utm_campaign));
  if (source) campaign.utm_source = source;
  if (medium) campaign.utm_medium = medium;
  if (name) campaign.utm_campaign = name;
  const referrer = signupReferrerSite(body.referrer_domain);
  if (referrer) campaign.referrer_domain = referrer;
  return campaign;
}
