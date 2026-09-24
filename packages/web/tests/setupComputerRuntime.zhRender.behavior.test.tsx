import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen, within } from "@testing-library/react";

import ServerSetupComputerRuntimeStep from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import { renderWithIntl } from "./helpers/intl";

// Render-level backstop. Source greps answer "is there English in this file?";
// only the DOM answers "what does a Chinese user see?". The two come apart when
// a MessageId is rendered bare — that prints "onboarding.computerRuntime.next"
// on screen while typecheck stays green and every scanner reports clean.

afterEach(cleanup);

const BASE = {
  computer: null,
  computerOnline: false,
  offlineComputers: [],
  hasConnectedComputer: false,
  serverSlug: "acme",
  setupCommand: "raft-computer setup",
  computerInstallCommand: "npm i -g @botiverse/raft-computer",
  windowsComputerSetupCommand: "raft-computer setup",
  windowsComputerInstallCommand: "npm i -g @botiverse/raft-computer",
  macLinuxDaemonCommand: "raft-daemon start",
  windowsDaemonCommand: "raft-daemon start",
  runtimeAnswered: false,
  ready: false,
  loading: false,
  error: "",
  verifyingComputer: false,
  detectedRuntimeNames: [],
  runtimeVisible: false,
  onNext: () => {},
} as never;

/** No catalog id may reach the screen. */
function assertNoRawIds(text: string) {
  const leaked = text.match(/\b(?:onboarding|machine|layout|validation|auth)\.[a-z][A-Za-z]*(?:\.[A-Za-z]+)+/g);
  assert.equal(leaked, null, `raw message id(s) rendered: ${leaked?.join(", ")}`);
}

test("first-time connect renders Chinese, not English and not raw ids", () => {
  const { container } = renderWithIntl(<ServerSetupComputerRuntimeStep {...BASE} />, { locale: "zh-cn" });
  const text = container.textContent ?? "";

  assertNoRawIds(text);
  assert.match(text, /设置你的服务器/);
  assert.match(text, /连接一台计算机/);
  assert.match(text, /计算机是你的 Agent 运行的机器/);
  assert.match(text, /下一步/);
  for (const english of ["Set up your server", "Connect a computer", "Next", "How to connect"]) {
    assert.ok(!text.includes(english), `English still on screen: ${english}`);
  }
  // The instructions list's accessible name is translated too — an untranslated
  // aria-label survives every visual check.
  assert.equal(
    screen.getByTestId("onboarding-computer-instructions").getAttribute("aria-label"),
    "如何连接一台计算机",
  );
});

test("the recovery card renders Chinese, including the reused Computer-page prompt", () => {
  const { container } = renderWithIntl(
    <ServerSetupComputerRuntimeStep
      {...BASE}
      hasConnectedComputer
      canReset
      onStartOver={() => {}}
      offlineComputers={[{ id: "c1", name: "Maria", lastHeartbeat: null, isComputer: true }]}
    />,
    { locale: "zh-cn" },
  );
  const text = container.textContent ?? "";

  assertNoRawIds(text);
  assert.match(text, /启动你的计算机/);
  assert.match(text, /让 Maria 重新上线/);
  assert.match(text, /离线/);
  // Reused from machine.detail — it must render, not just resolve.
  assert.match(text, /不确定为什么离线/);
  assert.match(text, /重新开始/);
  assert.ok(!text.includes("Start over"), "English rollback link is on screen");
  // The command itself stays ASCII: it is typed into a terminal.
  assert.match(text, /raft-computer start/);
});

test("the copy button's tooltip and accessible name are both translated", () => {
  renderWithIntl(
    <ServerSetupComputerRuntimeStep
      {...BASE}
      hasConnectedComputer
      offlineComputers={[{ id: "c1", name: "Maria", lastHeartbeat: null, isComputer: true }]}
    />,
    { locale: "zh-cn" },
  );
  const row = screen.getByTestId("onboarding-recovery-start-command").parentElement;
  assert.ok(row);
  const button = within(row).getByRole("button");
  assert.equal(button.getAttribute("aria-label"), "复制 raft-computer start");
  assert.equal(button.getAttribute("title"), "复制 raft-computer start");
});

test("english still renders english", () => {
  // Every zh assertion above would also pass if the zh catalog silently fell
  // back to the en overlay, so pin the other direction.
  const { container } = renderWithIntl(<ServerSetupComputerRuntimeStep {...BASE} />, { locale: "en" });
  const text = container.textContent ?? "";
  assertNoRawIds(text);
  assert.match(text, /Set up your server/);
  assert.match(text, /Connect a computer/);
  assert.match(text, /A computer is the machine your agents run on/);
});
