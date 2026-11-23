import "../../../../tests/helpers/domSetup";

// Delete Computer on the person's own Computer (DeleteComputerDialog): one request, revoke-computer-key with
// `delete: true`, which revokes the key and removes the machine together on the server. Never revoke and then a
// separate DELETE: once the key is revoked the person is no longer its controller, and a member's DELETE would be
// refused. Someone else's computer still goes through DELETE.
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../../../api/client";
import { useAuthStore } from "../../../store/authStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { DeleteComputerDialog } from "../DeleteComputerDialog";

const original = { post: api.post, delete: api.delete };
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const initialAuthState = useAuthStore.getState();

type Call = { method: string; url: string; body?: unknown };

afterEach(() => {
  cleanup();
  Object.assign(api, original);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
  useAuthStore.setState(initialAuthState, true);
});

function machine(attachedByMe: boolean): Machine {
  return {
    id: "m1",
    name: "Laptop",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "laptop",
    os: "darwin arm64",
    daemonVersion: "1.0.0",
    lastHeartbeat: null,
    createdAt: "2026-11-17T00:00:00.000Z",
    isComputer: true,
    computerAttachedByCurrentUser: attachedByMe,
    controlledByCurrentUser: attachedByMe,
    creator: attachedByMe ? { type: "human", id: "me", name: "me", displayName: null, avatarUrl: null, gravatarHash: "" } : null,
  } as Machine;
}

function mockApi(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  api.post = (async (url: string, body?: unknown) => {
    const call = { method: "post", url, body };
    calls.push(call);
    return { data: answer(call) } as never;
  }) as typeof api.post;
  api.delete = (async (url: string) => {
    const call = { method: "delete", url };
    calls.push(call);
    return { data: answer(call) } as never;
  }) as typeof api.delete;
  return calls;
}

function renderDialog(target: Machine, onClose: () => void) {
  useAuthStore.setState({ user: { id: "me" } } as never);
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", ownerId: "owner", role: "member", plan: "pro" } } as never);
  useMachineStore.setState({ machines: [target], selectedMachineId: target.id });
  return render(
    <TestIntlProvider>
      <DeleteComputerDialog machine={target} agents={[]} onClose={onClose} />
    </TestIntlProvider>,
  );
}

test("own Computer: one revoke-computer-key request with delete: true, no separate DELETE, and it leaves the list", async () => {
  const calls = mockApi(() => ({ ok: true, revokedComputers: 1, unboundAgentIds: [], deleted: true }));
  let closed = false;
  renderDialog(machine(true), () => { closed = true; });

  fireEvent.click(screen.getByRole("button", { name: "Delete computer" }));
  await waitFor(() => assert.equal(closed, true));

  assert.deepEqual(calls, [{ method: "post", url: "/servers/server-1/machines/m1/revoke-computer-key", body: { delete: true } }]);
  assert.deepEqual(useMachineStore.getState().machines.map((m) => m.id), []);
  assert.equal(useMachineStore.getState().selectedMachineId, null);
});

test("own Computer with other people's agents: the 409 lists them, then Force Unbind and Delete sends forceAgentIds in the same single request", async () => {
  const calls = mockApi((call) => {
    const body = call.body as { forceAgentIds?: string[] } | undefined;
    if (call.method === "post" && !body?.forceAgentIds) {
      throw Object.assign(new Error("conflict"), {
        response: {
          status: 409,
          data: {
            code: "others_agents_on_computer",
            error: "Other people's agents run on this computer.",
            agents: [{ id: "a1", name: "alpha", owner: { id: "c1", name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null }],
          },
        },
      });
    }
    return { ok: true, revokedComputers: 1, unboundAgentIds: ["a1"], deleted: true };
  });
  let closed = false;
  renderDialog(machine(true), () => { closed = true; });

  fireEvent.click(screen.getByRole("button", { name: "Delete computer" }));
  fireEvent.click(await screen.findByRole("button", { name: /Force unbind/i }));
  const confirm = await screen.findAllByRole("button", { name: /Force unbind and delete/i });
  fireEvent.click(confirm.at(-1)!);
  await waitFor(() => assert.equal(closed, true));

  assert.deepEqual(calls.map((call) => [call.method, call.url, call.body]), [
    ["post", "/servers/server-1/machines/m1/revoke-computer-key", { delete: true }],
    ["post", "/servers/server-1/machines/m1/revoke-computer-key", { delete: true, forceAgentIds: ["a1"] }],
  ]);
});

test("someone else's computer: DELETE as before, no revoke", async () => {
  const calls = mockApi(() => ({ ok: true }));
  let closed = false;
  renderDialog(machine(false), () => { closed = true; });

  fireEvent.click(screen.getByRole("button", { name: "Delete computer" }));
  await waitFor(() => assert.equal(closed, true));
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [["delete", "/servers/server-1/machines/m1"]]);
});
