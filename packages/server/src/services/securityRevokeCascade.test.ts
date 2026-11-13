import assert from "node:assert/strict";
import { securityRevokeCascadeEventAttrs } from "./securityRevokeCascade";
import { SecurityRevokeTally } from "./securityRevokeNotice";

test("the cascade's trace event counts what the run revoked, without ids", () => {
  const tally = new SecurityRevokeTally();
  tally.computer("user-a", "server-1");
  tally.computer("user-a", "server-2");
  tally.key("user-a", "server-1");
  tally.key("user-b", "server-3");
  tally.key(null, "server-9"); // no person: not counted, as for the email
  const attrs = securityRevokeCascadeEventAttrs(tally, "password_change", 0);
  assert.deepEqual(attrs, {
    event_kind: "security_revoke_cascade",
    trigger: "password_change",
    people: 2,
    computers: 2,
    keys: 2,
    servers: 3,
    revoked_any: true,
    failed_parts: 0,
  });
  assert.ok(!JSON.stringify(attrs).includes("user-a") && !JSON.stringify(attrs).includes("server-1"));
});

test("a run that revoked nothing still records its trigger, so its rate stays countable", () => {
  const attrs = securityRevokeCascadeEventAttrs(new SecurityRevokeTally(), "repair", 1);
  assert.equal(attrs.revoked_any, false);
  assert.equal(attrs.people, 0);
  assert.equal(attrs.failed_parts, 1);
  assert.equal(attrs.trigger, "repair");
});
