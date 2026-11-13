import assert from "node:assert/strict";
import { installRouteRegistrationCapture } from "../src/test/routeRegistrationCapture";
import {
  checkRouteClassification,
  PINNED_BUCKET_COUNTS,
  ROUTE_AUTHORITY_CLASSIFICATION,
} from "../src/test/routeAuthorityClassification";
process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
const capture = installRouteRegistrationCapture();
try {
  const session = capture.session();
  const { createApp } = await import("../src/app");
  const app = createApp() as unknown as { router: object };
  const { routes, problems } = session.collect(app.router);
  assert.deepEqual(problems, []);
  const classified = checkRouteClassification(routes);
  assert.deepEqual(classified, {
    unclassified: [],
    stale: [],
    duplicates: [],
    missingReasons: [],
    pinnedCounts: PINNED_BUCKET_COUNTS,
  });
  const multi = "POST /api/channels/joint-invites/accept-many";
  const missing = checkRouteClassification(
    routes,
    ROUTE_AUTHORITY_CLASSIFICATION.filter((row) => row.route !== multi),
  );
  assert.deepEqual(
    missing.unclassified,
    [multi],
    "dropping the new row must fail the real route inventory",
  );
  console.log(
    "PASS runtime mutating route classification and missing multi-accept reverse control",
  );
} finally {
  capture.restore();
}
