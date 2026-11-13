/**
 * Registering a Computer's machine key and rotating it (#12289): with
 * two-step verification on, the server refuses a web sign-in that hasn't
 * passed the second step in the last 10 minutes (403
 * second_factor_step_up_required). "Verify it's you" opens, and the request
 * runs once more; closing it cancels with nothing reported.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, test } from "vitest";

import api from "../src/api/client";
import SecondFactorStepUpHost from "../src/components/settings/SecondFactorStepUpHost";
import { isSecondFactorStepUpCancelled, resetSecondFactorStepUpForTests } from "../src/components/settings/secondFactorStepUp";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

const STEP_UP_URL = "/auth/second-factor/step-up";
const MACHINE = { id: "machine-1", name: "my-computer", status: "offline", runtimes: [] };
const originalApiPost = api.post;

type Handler = (body: unknown) => unknown;
type Call = { url: string; body: unknown };

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function stepUpRequired() {
  return httpError(403, { error: "Verify it's you first.", code: "second_factor_step_up_required", methods: ["totp", "backup_code"] });
}

function fail(err: Error): Handler {
  return () => {
    throw err;
  };
}

/** Each URL answers with its handlers in turn (the last one repeats); a thrown value is the failure. */
function stubPosts(handlers: Record<string, Handler[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
  return calls;
}

function renderHost() {
  render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <SecondFactorStepUpHost />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  fireEvent.click(button);
}

/** The dialog is loaded on first use (lazy), so it may take a moment. */
function findVerifyDialog() {
  return screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
}

beforeEach(() => {
  useServerStore.setState({ current: { id: "server-1" } } as never);
  useMachineStore.setState({ machines: [] } as never);
});

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  api.post = originalApiPost;
  localStorage.clear();
});

test("registering a machine asks for the second step, then registers once more", async () => {
  const calls = stubPosts({
    "/servers/server-1/machines": [fail(stepUpRequired()), () => ({ machine: MACHINE, apiKey: "sk_machine_fixture" })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  renderHost();

  const registering = useMachineStore.getState().registerMachine("my-computer");
  const dialog = await findVerifyDialog();
  fireEvent.change(within(dialog).getByLabelText("Authenticator code"), { target: { value: "123456" } });
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Verify" }));

  const result = await registering;
  assert.equal(result.apiKey, "sk_machine_fixture");
  assert.equal(result.machine.id, "machine-1");
  assert.deepEqual(calls, [
    { url: "/servers/server-1/machines", body: { name: "my-computer" } },
    { url: STEP_UP_URL, body: { code: "123456" } },
    { url: "/servers/server-1/machines", body: { name: "my-computer" } },
  ]);
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
});

test("closing the dialog cancels registering: no machine and nothing retried", async () => {
  const calls = stubPosts({
    "/servers/server-1/machines": [fail(stepUpRequired())],
  });
  renderHost();

  const registering = useMachineStore.getState().registerMachine("my-computer");
  const dialog = await findVerifyDialog();
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Cancel" }));

  const outcome = await registering.then(() => "registered", (err: unknown) => (isSecondFactorStepUpCancelled(err) ? "cancelled" : "failed"));
  assert.equal(outcome, "cancelled");
  assert.equal(useMachineStore.getState().machines.length, 0);
  assert.equal(calls.length, 1);
});

test("rotating a machine key asks for the second step, then rotates once more", async () => {
  useMachineStore.setState({ machines: [{ ...MACHINE, apiKeyPrefix: "sk_machine_old_prefi" }] } as never);
  const calls = stubPosts({
    "/servers/server-1/machines/machine-1/rotate-key": [fail(stepUpRequired()), () => ({ apiKey: "sk_machine_new_prefix_and_rest" })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  renderHost();

  const rotating = useMachineStore.getState().rotateApiKey("machine-1");
  const dialog = await findVerifyDialog();
  fireEvent.change(within(dialog).getByLabelText("Authenticator code"), { target: { value: "654321" } });
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Verify" }));

  assert.equal(await rotating, "sk_machine_new_prefix_and_rest");
  assert.equal(calls.filter((call) => call.url.endsWith("/rotate-key")).length, 2);
});

test("without two-step verification nothing changes: no dialog, one request", async () => {
  const calls = stubPosts({
    "/servers/server-1/machines": [() => ({ machine: MACHINE, apiKey: "sk_machine_fixture" })],
  });
  renderHost();

  const result = await useMachineStore.getState().registerMachine("my-computer");
  assert.equal(result.apiKey, "sk_machine_fixture");
  assert.equal(calls.length, 1);
  assert.ok(screen.queryByRole("dialog") === null);
});
