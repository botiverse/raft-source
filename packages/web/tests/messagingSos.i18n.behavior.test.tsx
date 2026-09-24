import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import SOSDialog from "../src/components/message/SOSDialog";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => cleanup());

test("catalog pins SOS dialog MessageIds with Chinese and ICU", () => {
  assert.equal(en["message.sos.stopAllAgents"], "Stop All Agents");
  assert.equal(en["message.sos.stopAction"], "Stop");
  assert.equal(en["message.sos.agentsStopped"], "Agents Stopped");
  assert.equal(
    en["message.sos.confirmWarning"],
    "All running agents in #{channel} will stop immediately. You can provide new guidance before resuming them.",
  );
  assert.equal(en["message.sos.allStopped"], "All agents have been stopped.");
  assert.equal(
    en["message.sos.guidanceHint"],
    "Provide new guidance or corrections. All agents will see this when they resume.",
  );
  assert.equal(
    en["message.sos.guidancePlaceholder"],
    "e.g. Stop modifying the database schema — focus only on the frontend changes I described…",
  );
  assert.equal(en["message.sos.keepStopped"], "Keep Stopped");
  assert.equal(en["message.sos.resumeAll"], "Resume All");
  assert.equal(en["message.sos.stopping"], "Stopping…");
  assert.equal(en["message.sos.resuming"], "Resuming…");
  assert.match(en["message.sos.confirmWarning"], /\{channel\}/);
  assert.match(zh["message.sos.confirmWarning"], /\{channel\}/);
  assert.match(zh["message.sos.stopAllAgents"], /\p{Script=Han}/u);
  assert.notEqual(zh["message.sos.allStopped"], en["message.sos.allStopped"]);
});

test("SOS dialog ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "message.sos.confirmWarning" }, { channel: "ops" }),
    zh["message.sos.confirmWarning"].replace("{channel}", "ops"),
  );
  assert.doesNotMatch(zhIntl.formatMessage({ id: "message.sos.resumeAll" }), /Resume All/);
});

test("SOSDialog renders its real confirmation surface in zh-cn", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SOSDialog channelId="channel-1" channelName="紧急频道" onClose={() => undefined} />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByRole("heading").textContent, zh["message.sos.stopAllAgents"]);
  assert.equal(
    document.querySelector('[data-slot="sos-dialog-content"]')?.textContent,
    zh["message.sos.confirmWarning"].replace("{channel}", "紧急频道"),
  );
  assert.ok(screen.getByRole("button", { name: zh["common.confirm.cancel"] }));
  const stop = screen.getByRole("button", { name: zh["message.sos.stopAction"] });
  assert.match(stop.className, /bg-brutal-orange/);
  assert.doesNotMatch(stop.textContent ?? "", /Stop All Agents/);
});
