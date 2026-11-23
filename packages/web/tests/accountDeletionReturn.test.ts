import assert from "node:assert/strict";
import { accountSettingsAfterCancel } from "../src/pages/accountDeletionReturn";

// Cancel Deletion loads Settings › Account of the address's server, else of
// the last server used (the one `/` enters; the old last-location resume is gone).
test("Cancel Deletion returns to Settings › Account of the address's server, else the last server, else the start", () => {
  assert.equal(accountSettingsAfterCancel("/s/acme/settings/account/delete", "beta"), "/s/acme/settings/account");
  assert.equal(accountSettingsAfterCancel("/", "beta"), "/s/beta/settings/account");
  assert.equal(accountSettingsAfterCancel("/", "team space"), "/s/team%20space/settings/account");
  assert.equal(accountSettingsAfterCancel("/", null), "/");
});
