import assert from "node:assert/strict";
import test from "node:test";

import {
  changePasswordSettingsPath,
  isChangePasswordIntentPath,
  isChangePasswordSettingsIntent,
  serverEntryPath,
} from "../src/utils/changePasswordNavigation";

test("recognizes only the thin change-password intent route", () => {
  assert.equal(isChangePasswordIntentPath("/change-password"), true);
  assert.equal(isChangePasswordIntentPath("/change-password/"), true);
  assert.equal(isChangePasswordIntentPath("/change-password/extra"), false);
  assert.equal(isChangePasswordIntentPath("/.well-known/change-password"), false);
});

test("the password intent overrides remembered surfaces and targets server-scoped account settings", () => {
  assert.equal(
    serverEntryPath({
      serverSlug: "team space",
      rememberedSurface: "/s/team-space/channel/general",
      changePasswordIntent: true,
    }),
    "/s/team%20space/settings/account?open=change-password",
  );
  assert.equal(changePasswordSettingsPath("team"), "/s/team/settings/account?open=change-password");
});

test("ordinary entry still preserves the existing remembered/default-server behavior", () => {
  assert.equal(
    serverEntryPath({
      serverSlug: "team",
      rememberedSurface: "/s/team/channel/general",
      changePasswordIntent: false,
    }),
    "/s/team/channel/general",
  );
  assert.equal(
    serverEntryPath({
      serverSlug: "team",
      rememberedSurface: null,
      changePasswordIntent: false,
    }),
    "/s/team",
  );
});

test("account settings expands only for the exact open intent", () => {
  assert.equal(isChangePasswordSettingsIntent("?open=change-password"), true);
  assert.equal(isChangePasswordSettingsIntent("?open=change-password&embed=1"), true);
  assert.equal(isChangePasswordSettingsIntent("?open=password"), false);
  assert.equal(isChangePasswordSettingsIntent(""), false);
});
