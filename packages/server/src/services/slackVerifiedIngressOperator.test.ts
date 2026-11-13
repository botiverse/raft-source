import assert from "node:assert/strict";
import { parseSlackIngressOperatorRequest } from "../../scripts/slack-ingress-rollout";

test("Slack ingress status command is read-only", () => {
  assert.deepEqual(parseSlackIngressOperatorRequest([]), { action: "status" });
  assert.deepEqual(parseSlackIngressOperatorRequest(["status"]), { action: "status" });
  for (const args of [["pause"], ["enable"], ["status", "--generation", "2"], ["unknown"]]) {
    assert.throws(() => parseSlackIngressOperatorRequest(args), /reviewed deployment configuration/u);
  }
});
