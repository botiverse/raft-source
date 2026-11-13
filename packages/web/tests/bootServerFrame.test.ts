import assert from "node:assert/strict";

import { bootRequestsServerListEarly, isAuthHandoffPage, opensServerFrame } from "../src/boot/serverFrame";

test("server-frame pages send the server list early, except a social login callback", () => {
  assert.equal(opensServerFrame("/"), true);
  assert.equal(opensServerFrame("/s/raft/channel/x"), true);
  assert.equal(opensServerFrame("/login"), false);
  assert.equal(bootRequestsServerListEarly({ pathname: "/s/raft", search: "" }), true);
  assert.equal(bootRequestsServerListEarly({ pathname: "/s/raft", search: "?auth_callback=social" }), false);
  assert.equal(bootRequestsServerListEarly({ pathname: "/login/app", search: "" }), false);
});

test("a sign-in handoff page neither refreshes the stored session nor asks with it", () => {
  assert.equal(isAuthHandoffPage({ pathname: "/s/raft", search: "?auth_callback=social" }), true);
  assert.equal(isAuthHandoffPage({ pathname: "/", search: "?auth_callback=email" }), true);
  assert.equal(isAuthHandoffPage({ pathname: "/login/app", search: "" }), true);
  assert.equal(isAuthHandoffPage({ pathname: "/s/raft/channel/c", search: "?msg=m" }), false);
  assert.equal(bootRequestsServerListEarly({ pathname: "/", search: "?auth_callback=email" }), false);
});
