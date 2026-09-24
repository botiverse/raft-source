import assert from "node:assert/strict";
import test from "node:test";

import { CliError } from "../core/errors.js";
import {
  REVIEWER_ISOLATION_ENV,
  reviewerIsolationEnabled,
} from "./reviewerIsolation.js";

test("reviewer isolation is per invocation or explicit seat environment, defaulting off", () => {
  assert.equal(reviewerIsolationEnabled({}, {}), false);
  assert.equal(reviewerIsolationEnabled({ reviewerIsolation: true }, {}), true);
  assert.equal(reviewerIsolationEnabled({}, { [REVIEWER_ISOLATION_ENV]: "1" }), true);
  assert.equal(reviewerIsolationEnabled({}, { [REVIEWER_ISOLATION_ENV]: " TRUE " }), true);
  assert.equal(reviewerIsolationEnabled({}, { [REVIEWER_ISOLATION_ENV]: "0" }), false);
  assert.equal(reviewerIsolationEnabled({}, { [REVIEWER_ISOLATION_ENV]: "false" }), false);
});

test("reviewer isolation fails closed on an invalid seat environment value", () => {
  assert.throws(
    () => reviewerIsolationEnabled({}, { [REVIEWER_ISOLATION_ENV]: "sometimes" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.doesNotMatch(err.message, /message body|sender|timestamp/i);
      return true;
    },
  );
});
