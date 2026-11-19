import assert from "node:assert/strict";
import { OWNER_DISPATCH_MARK, isOwnerDispatch, noteOwnerDispatchStepUp, ownerDispatchMarkOf } from "./ownerDispatchMark";

test("the step-up gate's note lands on a dispatched request's mark, and nowhere else", () => {
  const dispatched = { [OWNER_DISPATCH_MARK]: { cardMessageId: "m", requestId: "r" } };
  assert.ok(isOwnerDispatch(dispatched));
  noteOwnerDispatchStepUp(dispatched);
  assert.equal(ownerDispatchMarkOf(dispatched)?.stepUpRequired, true);

  const direct = {};
  noteOwnerDispatchStepUp(direct);
  noteOwnerDispatchStepUp(undefined);
  assert.equal(isOwnerDispatch(direct), false, "a person's own request is never marked");
  // A client can't make one: a JSON body has no Symbol keys.
  const fromJson = JSON.parse(JSON.stringify({ stepUpRequired: true, "raft.assistantOwnerDispatch": {} })) as object;
  assert.equal(isOwnerDispatch(fromJson), false);
});
