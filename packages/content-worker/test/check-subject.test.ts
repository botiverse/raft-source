import assert from "node:assert/strict";
import test from "node:test";

import { checkSubjectOf } from "../src/checkSubject";

/**
 * A publish check's subject (src/checkSubject.ts, task #130): the server's checkContentSubject. The
 * Worker's use of it is raft-content-check-ticket.test.ts's.
 */

test("a check's subject is the server's checkContentSubject: v1:check:<artifact>:<version>", () => {
  assert.equal(
    checkSubjectOf("pt_11111111-1111-4111-8111-111111111111", "v_22222222-2222-4222-8222-222222222222"),
    "v1:check:pt_11111111-1111-4111-8111-111111111111:v_22222222-2222-4222-8222-222222222222",
  );
});
