import assert from "node:assert/strict";
import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import { vi } from "vitest";
import { en } from "../../../i18n/messages/en";
import { announceRuntimeConfigApply } from "../runtimeConfigApplyNotice";

const formatMessage = (({ id }: { id: keyof typeof en }, values?: Record<string, string>) => {
  let template: string = en[id];
  for (const [k, v] of Object.entries(values ?? {})) {
    template = template.replaceAll(`{${k}}`, v);
  }
  return template;
}) as unknown as IntlShape["formatMessage"];

afterEach(() => {
  vi.restoreAllMocks();
});

test("applied and restarted on an active agent show a plain confirmation with no restart button (#proj-runtime:#80)", () => {
  for (const configApply of ["applied", "restarted"] as const) {
    const success = vi.spyOn(toast, "success").mockReturnValue("t1");
    announceRuntimeConfigApply({
      configApply,
      agentActive: true,
      agentName: "Otter",
      formatMessage,
    });
    assert.equal(success.mock.calls.length, 1);
    const [title, opts] = success.mock.calls[0]!;
    assert.equal(title, "Otter's settings saved");
    assert.equal(opts?.description, en["agent.detail.runtimeConfigAppliedNow"]);
    assert.equal(opts?.action, undefined, `${configApply}: no manual restart button`);
    success.mockRestore();
  }
});

test("when_idle (older Computer without agent:config-interrupt-v1 while busy) shows plain confirmation with no Switch now button (#proj-runtime:#80)", () => {
  const success = vi.spyOn(toast, "success").mockReturnValue("t2");
  announceRuntimeConfigApply({
    configApply: "when_idle",
    agentActive: true,
    agentName: "Otter",
    newSession: true,
    formatMessage,
  });
  assert.equal(success.mock.calls.length, 1);
  const [, opts] = success.mock.calls[0]!;
  assert.equal(opts?.description, en["agent.detail.runtimeConfigNewSessionWhenIdle"]);
  assert.equal(opts?.action, undefined, "no Switch now button");
});

test("saved shows no manual restart prompt even if agentActive is true (#proj-runtime:#80)", () => {
  const success = vi.spyOn(toast, "success").mockReturnValue("t3");
  announceRuntimeConfigApply({
    configApply: "saved",
    agentActive: true,
    agentName: "Otter",
    formatMessage,
  });
  assert.equal(success.mock.calls.length, 0);
});
