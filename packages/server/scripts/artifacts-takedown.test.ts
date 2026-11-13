import assert from "node:assert/strict";
import { encodeArtifactShortId } from "@botiverse/raft-shared";
import { checkPurgeEndpoint, parseTakedownArgs } from "./artifacts-takedown";

const ID = "pt_0b9d5c1e-2f4a-4c7e-9d3b-5a6f7e8d9c0b";

test("show names one Artifact, by id or by a link that has one; it takes no reason", () => {
  assert.deepEqual(parseTakedownArgs(["--", "show", "--artifact", ID]), { command: "show", artifact: ID });
  assert.deepEqual(parseTakedownArgs(["show", "--artifact", `https://app.raft.build/artifacts/${ID}?v=2`]), { command: "show", artifact: ID });
  // The short id links carry, bare or in a link, is the same Artifact.
  const short = encodeArtifactShortId(ID.slice("pt_".length));
  assert.deepEqual(parseTakedownArgs(["show", "--artifact", short]), { command: "show", artifact: ID });
  assert.deepEqual(parseTakedownArgs(["show", "--artifact", `https://app.raft.build/artifacts/${short}/v/2`]), { command: "show", artifact: ID });
  assert.throws(() => parseTakedownArgs(["show"]), /name the Artifact/);
  assert.throws(() => parseTakedownArgs(["show", "--artifact", "my-report"]), /an Artifact id/);
  assert.throws(() => parseTakedownArgs(["show", "--artifact", ID, "--reason", "x"]), /unknown argument: --reason/);
  assert.throws(() => parseTakedownArgs(["delete", "--artifact", ID]), /show, takedown, restore or purge/);
});

test("takedown and restore need a reason (trimmed, at most 1000 characters); --operator is optional", () => {
  assert.deepEqual(parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "  report #12: phishing  "]), { command: "takedown", artifact: ID, reason: "report #12: phishing" });
  assert.deepEqual(parseTakedownArgs(["restore", "--artifact", ID, "--reason", "appeal upheld", "--operator", "alice"]), { command: "restore", artifact: ID, reason: "appeal upheld", operator: "alice" });
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID]), /--reason is required/);
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "   "]), /--reason is required/);
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "x".repeat(1001)]), /--reason is required/);
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "--operator"]), /--reason needs a value/);
});

test("purge needs a reason and only plans without --apply; --apply needs the approval, the run id and the accountable human, which are --apply's only", () => {
  const USER = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  const approved = ["--apply", "--approval-reference", "https://raft.build/m/1", "--run-id", "purge-2026-11-09.1", "--accountable-user-id", USER.toUpperCase()];
  assert.deepEqual(parseTakedownArgs(["purge", "--artifact", ID, "--reason", " report #9: illegal content "]), { command: "purge", artifact: ID, reason: "report #9: illegal content", apply: false });
  assert.deepEqual(parseTakedownArgs(["purge", "--artifact", ID, "--reason", "report #9", ...approved]), {
    command: "purge", artifact: ID, reason: "report #9", apply: true, approvalReference: "https://raft.build/m/1", runId: "purge-2026-11-09.1", accountableUserId: USER,
  });
  // The short id names the same Artifact.
  const short = encodeArtifactShortId(ID.slice("pt_".length));
  assert.deepEqual(parseTakedownArgs(["purge", "--artifact", short, "--reason", "r"]), { command: "purge", artifact: ID, reason: "r", apply: false });
  // --apply without any one of the three writes nothing.
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", "--apply"]), /--apply requires --approval-reference/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", ...approved.slice(0, 3), "--accountable-user-id", USER]), /--apply requires --run-id/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", ...approved.slice(0, 5)]), /--apply requires --accountable-user-id/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", ...approved.slice(0, 5), "--accountable-user-id", "alice"]), /--apply requires --accountable-user-id/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", "--run-id", "x"]), /only for --apply/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID]), /--reason is required: 1 to 1000 characters \(it goes in the purge record\)/);
  // A purge names no self-reported operator, and the old --confirm is gone.
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", "--operator", "alice"]), /unknown argument: --operator/);
  assert.throws(() => parseTakedownArgs(["purge", "--artifact", ID, "--reason", "r", "--confirm", ID]), /unknown argument: --confirm/);
  // --apply and its flags are purge's only.
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "r", "--apply"]), /--apply needs a value|unknown argument: --apply/);
  assert.throws(() => parseTakedownArgs(["takedown", "--artifact", ID, "--reason", "r", "--run-id", "x"]), /unknown argument: --run-id/);
});

test("purge --apply writes to the primary only; a plan reads either", () => {
  assert.match(checkPurgeEndpoint(true, true) ?? "", /--apply writes to the primary: DATABASE_URL is a replica/);
  assert.equal(checkPurgeEndpoint(true, false), null);
  assert.equal(checkPurgeEndpoint(false, true), null);
  assert.equal(checkPurgeEndpoint(false, false), null);
});
