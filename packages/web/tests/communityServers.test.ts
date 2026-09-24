import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMMUNITY_SERVER_SLUG,
  languageListPrefersChineseCommunity,
  recommendedCommunitySlug,
  shouldShowChineseCommunityEntryForLanguages,
} from "../src/utils/communityServers";

test("community recommendation detects Chinese browser language", () => {
  assert.equal(languageListPrefersChineseCommunity(["en-US", "zh-CN"]), true);
  assert.equal(languageListPrefersChineseCommunity(["zh-Hans-CN"]), true);
  assert.equal(languageListPrefersChineseCommunity(["en-US", "ja-JP"]), false);
});

test("Chinese community entry is gated by browser language", () => {
  assert.equal(shouldShowChineseCommunityEntryForLanguages(["zh-CN"]), true);
  assert.equal(shouldShowChineseCommunityEntryForLanguages(["en-US", "zh-Hant-TW"]), true);
  assert.equal(shouldShowChineseCommunityEntryForLanguages(["en-US", "ja-JP"]), false);
});

test("community recommendation keeps the default internal community server", () => {
  assert.equal(recommendedCommunitySlug([]), DEFAULT_COMMUNITY_SERVER_SLUG);
  assert.equal(recommendedCommunitySlug([{ slug: "community-cn" }]), DEFAULT_COMMUNITY_SERVER_SLUG);
});
