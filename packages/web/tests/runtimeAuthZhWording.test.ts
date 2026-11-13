import assert from "node:assert/strict";

import { zhCn } from "../src/i18n/messages/zh-cn";

// Kirby (#proj-raft-computer:64c0464e): zh says 退出登录 for a runtime's sign
// out, the same verb as Raft's own; the runtime's name tells them apart.
test("zh runtime sign-out copy says 退出登录, never 登出", () => {
  const offenders = Object.entries(zhCn as Record<string, string>)
    .filter(([id, text]) => id.startsWith("machine.runtimeAuth.") && text.includes("登出"))
    .map(([id]) => id);
  assert.deepEqual(offenders, []);
});
