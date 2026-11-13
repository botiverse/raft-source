import assert from "node:assert/strict";
import { parseSlackVerifiedIngressDeployment } from "./slackVerifiedIngressDeployment";

test("deployment configuration is explicit, monotone and requires a release record to enable", () => {
  assert.equal(parseSlackVerifiedIngressDeployment({}), undefined);
  assert.deepEqual(parseSlackVerifiedIngressDeployment({ SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "false",
    SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "1" }), { enabled: false, generation: 1 });
  assert.deepEqual(parseSlackVerifiedIngressDeployment({ SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true",
    SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "2",
    SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "00000000-0000-4000-8000-000000000022" }), {
    enabled: true, generation: 2, releaseRecord: "00000000-0000-4000-8000-000000000022" });
  for (const env of [
    { SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true", SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "1" },
    { SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true", SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "0",
      SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "00000000-0000-4000-8000-000000000022" },
    { SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true", SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "1",
      SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "not-a-release" },
    { SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "yes", SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "1" },
  ]) assert.throws(() => parseSlackVerifiedIngressDeployment(env));
});


test("protocol elevation is explicit and separately recorded in enabled deployment config", () => {
  const base = { SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true", SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "9",
    SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "00000000-0000-4000-8000-000000000022" };
  assert.deepEqual(parseSlackVerifiedIngressDeployment({ ...base, SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL: "2" }),
    { enabled: true, generation: 9, releaseRecord: base.SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD, minimumWriterProtocol: 2 });
  assert.throws(() => parseSlackVerifiedIngressDeployment({ ...base, SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL: "1" }));
  assert.throws(() => parseSlackVerifiedIngressDeployment({ ...base, SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "false",
    SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL: "2" }));
});

test("protocol 3 requires explicit enabled configuration and a release record", () => {
  const enabled = {
    SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true",
    SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "11",
    SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "00000000-0000-4000-8000-000000000033",
    SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL: "3",
  };
  assert.deepEqual(parseSlackVerifiedIngressDeployment(enabled), {
    enabled: true, generation: 11, releaseRecord: enabled.SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD,
    minimumWriterProtocol: 3,
  });
  assert.throws(() => parseSlackVerifiedIngressDeployment({ ...enabled, SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "false" }));
  assert.throws(() => parseSlackVerifiedIngressDeployment({ ...enabled, SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "" }));
  assert.throws(() => parseSlackVerifiedIngressDeployment({ ...enabled, SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL: "4" }));
});
