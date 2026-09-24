import assert from "node:assert/strict";
import { test } from "vitest";
import {
  __setAppMemberRefKeyForTests,
  deriveAppMemberRef,
} from "./appOutboundProjectionService.js";

test("member refs are stable only inside the app and installation boundary", () => {
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  const previousVersion = process.env.RAFT_APP_MEMBER_REF_KEY_VERSION;
  process.env.RAFT_APP_MEMBER_REF_KEY_VERSION = "3";
  try {
    const base = deriveAppMemberRef({ clientId: "app-a", installationId: "install-a", principalId: "member-a" });
    assert.deepEqual(
      deriveAppMemberRef({ clientId: "app-a", installationId: "install-a", principalId: "member-a" }),
      base,
    );
    assert.equal(base.key_version, 3);
    process.env.RAFT_APP_MEMBER_REF_KEY_VERSION = "4";
    const nextVersion = deriveAppMemberRef({ clientId: "app-a", installationId: "install-a", principalId: "member-a" });
    assert.equal(nextVersion.key_version, 4);
    assert.notEqual(nextVersion.member_ref, base.member_ref);
    process.env.RAFT_APP_MEMBER_REF_KEY_VERSION = "3";
    assert.notEqual(
      deriveAppMemberRef({ clientId: "app-b", installationId: "install-a", principalId: "member-a" }).member_ref,
      base.member_ref,
    );
    assert.notEqual(
      deriveAppMemberRef({ clientId: "app-a", installationId: "install-b", principalId: "member-a" }).member_ref,
      base.member_ref,
    );
    assert.notEqual(
      deriveAppMemberRef({ clientId: "app-a", installationId: "install-a", principalId: "member-b" }).member_ref,
      base.member_ref,
    );
    assert.notEqual(
      deriveAppMemberRef({ clientId: "ab", installationId: "c", principalId: "d" }).member_ref,
      deriveAppMemberRef({ clientId: "a", installationId: "bc", principalId: "d" }).member_ref,
    );
  } finally {
    __setAppMemberRefKeyForTests(null);
    if (previousVersion === undefined) delete process.env.RAFT_APP_MEMBER_REF_KEY_VERSION;
    else process.env.RAFT_APP_MEMBER_REF_KEY_VERSION = previousVersion;
  }
});
