import type { CommunityServerSlug } from "../store/serverStore";

export const DEFAULT_COMMUNITY_SERVER_SLUG: CommunityServerSlug = "community";
export const CHINESE_COMMUNITY_SERVER_SLUG: CommunityServerSlug = "community-cn";
export const CHINESE_COMMUNITY_PAGE_PATH = "/community/chinese";

const CHINESE_LANGUAGE_RE = /^zh(?:-|$)/i;

export function languageListPrefersChineseCommunity(languages: Array<string | null | undefined>) {
  return languages.some((language) => typeof language === "string" && CHINESE_LANGUAGE_RE.test(language));
}

export function browserPrefersChineseCommunity() {
  const browserNavigator = typeof window !== "undefined" ? window.navigator : typeof navigator === "undefined" ? null : navigator;
  if (!browserNavigator) return false;
  const languages = [
    ...(Array.isArray(browserNavigator.languages) ? browserNavigator.languages : []),
    browserNavigator.language,
  ].filter((language): language is string => typeof language === "string" && language.length > 0);
  return languageListPrefersChineseCommunity(languages);
}

export function hasJoinedCommunity(servers: Array<{ slug: string }>, slug: CommunityServerSlug) {
  return servers.some((server) => server.slug === slug);
}

export function shouldShowChineseCommunityEntryForLanguages(languages: Array<string | null | undefined>) {
  return languageListPrefersChineseCommunity(languages);
}

export function shouldShowChineseCommunityEntry() {
  return browserPrefersChineseCommunity();
}

export function recommendedCommunitySlug(_servers: Array<{ slug: string }>) {
  return DEFAULT_COMMUNITY_SERVER_SLUG;
}
