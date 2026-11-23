import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import api from "../src/api/client";
import AddMachineDialog from "../src/components/machine/AddMachineDialog";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

// Add Computer's "The terminal shows a code? Enter it here.": a setup run over
// SSH shows a device code, approved from this window with the device login
// page's describe/approve and the same confirm screen, for this window's
// server only. What the person sees before consenting is the safeguard (web
// DOM test prune rule), so it is pinned here.

vi.mock("../src/components/machine/localComputer/useLocalComputerHost", () => ({
  useLocalComputerHost: () => null,
}));

const originalPost = api.post;
const initialServerState = useServerStore.getState();
const initialMachineState = useMachineStore.getState();

const ACME = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" };
const BETA = { id: "22222222-2222-4222-8222-222222222222", slug: "beta", name: "Beta Labs" };

const server: Server = {
  id: ACME.id,
  name: ACME.name,
  avatarUrl: null,
  slug: ACME.slug,
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const REQUEST = {
  userCode: "VSWA-7M58",
  clientName: "raft-computer",
  requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  requester: { ip: "203.0.113.7", location: "São Paulo, BR" },
  approvalTicket: "ticket-1",
};
const ATTACH_REQUEST = {
  ...REQUEST,
  grant: { kind: "computer_attach", machineName: "build-box", hostname: "build-box.lan", os: "Linux", servers: [BETA, ACME] },
};

type Post = { url: string; body: unknown };

function mockApi(handlers: Record<string, () => unknown>): Post[] {
  const posts: Post[] = [];
  api.post = (async (url: string, body: unknown) => {
    // The window's pairing (computerAddPairing.behavior.test.tsx) is off here:
    // a server without it, as before pairing, so only the typed code's calls count.
    if (url.includes("computer-pairings")) throw { response: { status: 404, data: {} } };
    posts.push({ url, body });
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected POST ${url}`);
    return { data: handler() };
  }) as typeof api.post;
  return posts;
}

function failWith(code: string, extra: Record<string, unknown> = {}) {
  return () => {
    throw { response: { data: { code, ...extra } } };
  };
}

let closed = 0;

beforeEach(() => {
  closed = 0;
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ machines: [], addMachineIntent: null, loadMachines: async () => undefined });
});

afterEach(() => {
  cleanup();
  api.post = originalPost;
  useServerStore.setState(initialServerState, true);
  useMachineStore.setState(initialMachineState, true);
});

function mountDialog() {
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computers"]}>
      <Routes>
        <Route path="/s/acme/computers" element={<AddMachineDialog onClose={() => { closed += 1; }} />} />
        <Route path="/login/device" element={<p>device login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function enterCode(code = " vswa-7m58 ") {
  await click(screen.getByRole("button", { name: "The terminal shows a code? Enter it here." }));
  fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), { target: { value: code } });
  await click(screen.getByRole("button", { name: "Continue" }));
}

test("a code from the terminal: the device page's confirm screen, then approve for this server, then success while still waiting", async () => {
  const posts = mockApi({ "/auth/device/describe": () => ATTACH_REQUEST, "/auth/device/approve": () => ({ ok: true, action: "approved" }) });
  mountDialog();
  // Closed until asked for: the command first.
  assert.ok(screen.queryByPlaceholderText("XXXX-XXXX") === null);
  await enterCode();

  // Normalized as the device page does; in the body, never an address.
  assert.deepEqual(posts, [{ url: "/auth/device/describe", body: { userCode: "VSWA-7M58" } }]);
  assert.ok(await screen.findByText("Add “build-box” to a server"));
  assert.ok(screen.getByText("“build-box”"));
  assert.ok(screen.getByText("build-box.lan · Linux"));
  assert.ok(screen.getByText("203.0.113.7 · São Paulo, BR"));
  assert.ok(screen.getByText(/2 minutes ago/));
  assert.ok(screen.getByText(/approving adds their computer to the server you pick/));
  // This window's server, named, with nothing to pick.
  assert.ok(screen.getByText("/acme"));
  assert.ok(screen.queryByRole("radiogroup") === null);
  assert.ok(screen.queryByText("Beta Labs") === null);

  await click(screen.getByRole("button", { name: "Add to server" }));
  assert.deepEqual(posts[1], {
    url: "/auth/device/approve",
    body: { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1", serverId: ACME.id },
  });
  assert.ok(await screen.findByText("“build-box” will be added to Acme. It shows up here once it connects."));
  // Still the command step, waiting for the computer to connect.
  assert.ok(screen.getByText("Waiting for computer to connect..."));
});

for (const [code, text] of [
  ["expired", "That code has expired. Start the login again."],
  ["user_code_invalid", "That code is invalid. Check the code shown where you started this login and try again."],
  ["already_resolved", "That login request was already approved or denied. Start the login again if needed."],
] as const) {
  test(`a code that can't be approved (${code}) says why in the field, before any approval`, async () => {
    const posts = mockApi({ "/auth/device/describe": failWith(code) });
    mountDialog();
    await enterCode();

    assert.ok(await screen.findByText(text));
    assert.ok(screen.getByPlaceholderText("XXXX-XXXX"));
    assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
  });
}

test("a code for a server this window isn't for: no approve here, the device login page instead (without the code)", async () => {
  const posts = mockApi({ "/auth/device/describe": () => ({ ...ATTACH_REQUEST, grant: { ...ATTACH_REQUEST.grant, servers: [BETA] } }) });
  mountDialog();
  await enterCode();

  assert.ok(await screen.findByText(/This code can’t add the computer to this server from here/));
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
  await click(screen.getByRole("button", { name: "Open the device login page" }));
  assert.equal(closed, 1);
  assert.ok(screen.getByText("device login page"));
  assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
});

for (const [label, request] of [
  ["a sign-in", REQUEST],
  ["an agent key", { ...REQUEST, grant: { kind: "agent_key", machineName: "ci", hostname: null, os: null, requestedAgentId: null, agents: [] } }],
] as const) {
  test(`${label} code is not approved here: it says so and offers the device login page`, async () => {
    const posts = mockApi({ "/auth/device/describe": () => request });
    mountDialog();
    await enterCode();

    assert.ok(await screen.findByText(/This code isn’t for adding a computer/));
    assert.ok(screen.getByRole("button", { name: "Open the device login page" }));
    assert.ok(screen.queryByRole("button", { name: "Approve device login" }) === null);
    assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
  });
}

test("a grant kind it doesn't know is refused, with the device login page offered", async () => {
  mockApi({ "/auth/device/describe": () => ({ ...REQUEST, grant: { kind: "computer_adopt", machineName: "old", hostname: null, os: null } }) });
  mountDialog();
  await enterCode();

  assert.ok(await screen.findByText(/This kind of device login isn't supported here/));
  assert.ok(screen.getByRole("button", { name: "Open the device login page" }));
});

test("two-step verification: the approval asks for the step-up, then approves the same request for this server", async () => {
  let approvals = 0;
  const posts = mockApi({
    "/auth/device/describe": () => ATTACH_REQUEST,
    "/auth/device/approve": () => {
      approvals += 1;
      if (approvals === 1) failWith("second_factor_step_up_required", { methods: ["totp"] })();
      return { ok: true, action: "approved" };
    },
    "/auth/second-factor/step-up": () => ({ ok: true }),
  });
  const view = mountDialog();
  await enterCode();
  await click(await screen.findByRole("button", { name: "Add to server" }));

  assert.ok(await screen.findByText("Two-step verification is on for this account. Verify it's you before approving a device login."));
  const field = view.container.ownerDocument.querySelector('input[name="one-time-code"]');
  assert.ok(field);
  fireEvent.change(field, { target: { value: "123456" } });
  await click(screen.getByRole("button", { name: "Verify" }));

  assert.ok(await screen.findByText("“build-box” will be added to Acme. It shows up here once it connects."));
  const approves = posts.filter((post) => post.url === "/auth/device/approve");
  assert.equal(approves.length, 2);
  assert.deepEqual(approves[1]!.body, { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1", serverId: ACME.id });
});

test("deny: no ticket, no server, and nothing added", async () => {
  const posts = mockApi({ "/auth/device/describe": () => ATTACH_REQUEST, "/auth/device/approve": () => ({ ok: true, action: "denied" }) });
  mountDialog();
  await enterCode();
  await click(await screen.findByRole("button", { name: "Deny" }));

  assert.deepEqual(posts[1], { url: "/auth/device/approve", body: { userCode: "VSWA-7M58", approve: false } });
  assert.ok(await screen.findByText("Denied. Nothing was added to Acme."));
});

test("a different code after a confirm screen: the next approval carries the new code's own ticket", async () => {
  let describes = 0;
  const posts = mockApi({
    "/auth/device/describe": () => {
      describes += 1;
      return describes === 1 ? ATTACH_REQUEST : { ...ATTACH_REQUEST, userCode: "WXYZ-2345", approvalTicket: "ticket-2" };
    },
    "/auth/device/approve": () => ({ ok: true, action: "approved" }),
  });
  mountDialog();
  await enterCode();
  await click(await screen.findByRole("button", { name: "Enter a different code" }));
  // Back to an empty field, the old request gone.
  assert.equal((screen.getByPlaceholderText("XXXX-XXXX") as HTMLInputElement).value, "");
  fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), { target: { value: "wxyz-2345" } });
  await click(screen.getByRole("button", { name: "Continue" }));
  await click(await screen.findByRole("button", { name: "Add to server" }));

  assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe", "/auth/device/describe", "/auth/device/approve"]);
  assert.deepEqual(posts[2]!.body, { userCode: "WXYZ-2345", approve: true, approvalTicket: "ticket-2", serverId: ACME.id });
});

test("rights gone between describe and approve: the server's refusal shows, nothing approved, the device login page offered", async () => {
  mockApi({ "/auth/device/describe": () => ATTACH_REQUEST, "/auth/device/approve": failWith("grant_selection_not_allowed") });
  mountDialog();
  await enterCode();
  await click(await screen.findByRole("button", { name: "Add to server" }));

  assert.ok(await screen.findByText(/You can't add computers to that server/));
  assert.ok(screen.getByRole("button", { name: "Open the device login page" }));
  assert.ok(screen.queryByTestId("add-machine-code-approved") === null);
});
