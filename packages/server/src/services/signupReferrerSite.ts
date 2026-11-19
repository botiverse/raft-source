import { isRaftSiteHost, referrerHost } from "@botiverse/raft-shared";
import { appHosts } from "../platform/links";
import { referrerSite } from "./publicVisitCounts";

/**
 * The referring site of a web sign-up (cindyz, 2026-11-13,
 * #proj-analytics:72b5e0e2) for `account_created.referrer_domain`, from the
 * `referrer_domain` the web sends in the sign-up body (the landing site's
 * `ref_domain` link parameter). Stored as `public_page_viewed.referrer_domain`
 * is: the registrable domain only (`referrerSite`), because a host name can
 * name a person or an internal system. Null, so left out, when it is not a
 * bare host name, when the Public Suffix List does not know its suffix, and
 * when it is one of Raft's own hosts (raft.build and its subdomains, this
 * deployment's app host and the hosts its links are recognised on: `appHosts`).
 * The app hosts are compared as `referrerHost` leaves a host, without a leading
 * `www.`: an app served from `www.example.com` is its own site under that name
 * and under `example.com`.
 */
export function signupReferrerSite(raw: unknown): string | null {
  const host = referrerHost(typeof raw === "string" ? raw : null);
  if (!host) return null;
  if (isRaftSiteHost(host) || appHosts().some((own) => own.replace(/^www\./, "") === host)) return null;
  return referrerSite(host);
}
