import assert from "node:assert/strict";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

test("Computer creator uses the same localized Created and Creator labels as Agent profiles", () => {
  assert.equal(en["common.handle"], "@{name}");
  assert.match(zhCn["machine.detail.created"], /创建/);
  assert.match(zhCn["agent.detail.creator"], /创建者/);
  assert.match(zhCn["agent.detail.noCreatorAssigned"], /创建者/);
  assert.equal(zhCn["common.handle"], "@{name}");
});
