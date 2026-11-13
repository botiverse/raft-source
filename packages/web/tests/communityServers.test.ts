import assert from "node:assert/strict";
import {
  shouldShowChineseCommunityEntry,
} from "../src/utils/communityServers";

test("Chinese community entry is gated by the active display locale", () => {
  assert.equal(shouldShowChineseCommunityEntry("zh-cn"), true);
  assert.equal(shouldShowChineseCommunityEntry("zh-tw"), true);
  assert.equal(shouldShowChineseCommunityEntry("ja"), false);
  assert.equal(shouldShowChineseCommunityEntry("en"), false);
});
