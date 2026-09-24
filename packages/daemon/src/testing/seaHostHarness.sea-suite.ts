import assert from "node:assert/strict";
import { test } from "vitest";
import { runSeaHostProbe } from "./seaHostHarness.js";

/**
 * SEPARATE SUITE, NOT PART OF THE DEFAULT DAEMON UNIT RUN.
 *
 * It builds a real single-executable application (node --experimental-sea-config
 * → postject → codesign on darwin) and takes ~10s with external toolchain
 * dependencies. In the default unit suite that would be a flake source, and an
 * unstable gate is worse than no gate. Run it when host-detection changes.
 *
 * Deliberately runs without a force-exit escape hatch. An instrument whose
 * whole value is that its output counts as evidence must not use a mechanism
 * capable of dropping its own reporter tail. The harness uses `spawnSync`,
 * which leaves no dangling handles; if this ever hangs, fix the unclosed handle.
 *
 * NOBODY IS WATCHING THIS SWITCH. No hosted gate runs this suite: it sits
 * outside the default test glob on purpose (the `.sea-suite.ts` suffix), and no
 * workflow references `test:sea-host`. This is structural, not incidental:
 * `mutation-diff-gate` is the only mutation-aware check and it mutates only
 * web source with the web DOM suite as its oracle, so a daemon file is not in
 * its universe at all — and it is advisory anyway. No existing gate could ever
 * protect this suite. A green CI run on a change to this file therefore says
 * only "nothing else broke" — never "this harness still works". If someone edits it into a
 * permanent pass, no gate turns red and the next person to notice is whoever
 * remembers to run it by hand.
 *
 * So after ANY change here, verification is manual and has two parts, both
 * required: run `pnpm --filter @botiverse/raft-daemon test:sea-host`, and
 * re-run the two mutations — point the first build step at a non-existent
 * binary (must report NOT_OBSERVED and FAIL), and make the probe emit a
 * constant "sea" (must FAIL on the plain-node leg). Passing without those is
 * a green you have not earned, which is the exact defect this file exists to
 * catch, sitting on the file itself.
 *
 * COVERAGE BOUNDARY — a green run here means exactly one thing: the host-kind
 * probe answers "sea" inside a genuine SEA and "node" outside one. It does NOT
 * cover the Computer SEA artifact (packaging, self-re-exec, `__cli` sentinel),
 * does NOT cover cliTransport on a real SEA, and does NOT cover Windows.
 */
test("SEA HOST HARNESS: the real probe answers sea inside a SEA and node outside one", () => {
  const outcome = runSeaHostProbe();

  if (outcome.status === "not_observed") {
    // Deliberately not a skip and not a pass. A missing toolchain must be
    // visible as an absent observation — rendering absence as health is the
    // exact defect this harness was built to catch.
    assert.fail(`NOT_OBSERVED(${outcome.reason}): ${outcome.detail}`);
  }

  // Direction 1: the branch that is unreachable from a plain-Node test host.
  assert.equal(outcome.seaHostKind, "sea", "a genuine SEA must be classified as sea");

  // Direction 2: without this, a harness that always answered "sea" would
  // pass direction 1 forever. Two directions are what make one of them
  // evidence rather than a coincidence.
  assert.equal(outcome.nodeHostKind, "node", "the same probe outside a SEA must classify as node");

  assert.notEqual(
    outcome.seaHostKind,
    outcome.nodeHostKind,
    "the probe must distinguish the two hosts, not return a constant",
  );
});
