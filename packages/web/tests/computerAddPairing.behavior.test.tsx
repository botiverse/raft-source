import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import AddMachineDialog from "../src/components/machine/AddMachineDialog";
import { PAIRING_POLL_MS, PAIRING_RENEW_MS } from "../src/features/computer/useComputerPairing";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { getComputerCommands } from "../src/utils/computerSetupCommand";
import { renderWithIntl } from "./helpers/intl";

// Add Computer's pairing (docs/contracts/computer-pairing.md, design §11 B):
// the one-paste command carries `--pair`, a Computer that runs it shows up
// in this window for the device login's confirm screen, and a command run
// more than once is approvable from nowhere here (Tenny 937c6726, rule 1).
// What the person sees before consenting is the safeguard, so it is pinned.

vi.mock("../src/components/machine/localComputer/useLocalComputerHost", () => ({
  useLocalComputerHost: () => null,
}));

type Listener = (payload: unknown) => void;
const socketListeners = new Map<string, Set<Listener>>();
const fakeSocket = {
  on(event: string, listener: Listener) {
    if (!socketListeners.has(event)) socketListeners.set(event, new Set());
    socketListeners.get(event)!.add(listener);
    return fakeSocket;
  },
  off(event: string, listener: Listener) {
    socketListeners.get(event)?.delete(listener);
    return fakeSocket;
  },
};
vi.mock("../src/api/socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/socket")>()),
  getSocket: () => fakeSocket,
}));

async function emit(event: string, payload: unknown) {
  await act(async () => {
    for (const listener of [...(socketListeners.get(event) ?? [])]) listener(payload);
  });
}

const originalPost = api.post;
const initialServerState = useServerStore.getState();
const initialMachineState = useMachineStore.getState();

const ACME_ID = "11111111-1111-4111-8111-111111111111";
const server: Server = {
  id: ACME_ID,
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const PAIRING_ID = "pair_Ab3-x9Qz";
const PAIRING_REF = "pairing-row-1";
const CREATED = { pairingId: PAIRING_ID, pairingRef: PAIRING_REF, serverId: ACME_ID, expiresAt: "2026-11-19T12:10:00.000Z" };
const LINKED_REQUEST = {
  userCode: "VSWA-7M58",
  clientName: "raft-computer",
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  requester: { ip: "203.0.113.7", location: "Frankfurt, DE" },
  approvalTicket: "ticket-1",
  grant: { kind: "computer_attach", machineName: "mac-mini", hostname: "mac-mini.lan", os: "Linux x64" },
};
const REQUESTED = { pairingRef: PAIRING_REF, serverId: ACME_ID, state: "requested", expiresAt: CREATED.expiresAt, request: LINKED_REQUEST };
const WAITING = { pairingRef: PAIRING_REF, serverId: ACME_ID, state: "waiting", expiresAt: CREATED.expiresAt };

type Post = { url: string; body: unknown };
type Handler = (body: unknown) => unknown;

function mockApi(handlers: Record<string, Handler>): Post[] {
  const posts: Post[] = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected POST ${url}`);
    return { data: handler(body) };
  }) as typeof api.post;
  return posts;
}

function failWith(code: string, extra: Record<string, unknown> = {}) {
  return () => {
    throw { response: { status: 409, data: { code, ...extra } } };
  };
}

const CREATE_URL = `/servers/${ACME_ID}/computer-pairings`;

beforeEach(() => {
  socketListeners.clear();
  localStorage.clear();
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ machines: [], addMachineIntent: null, loadMachines: async () => undefined });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  api.post = originalPost;
  useServerStore.setState(initialServerState, true);
  useMachineStore.setState(initialMachineState, true);
});

async function mountDialog() {
  let view!: ReturnType<typeof renderWithIntl>;
  await act(async () => {
    view = renderWithIntl(
      <MemoryRouter initialEntries={["/s/acme/computers"]}>
        <AddMachineDialog onClose={() => undefined} />
      </MemoryRouter>,
    );
  });
  return view;
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function pageText(view: ReturnType<typeof renderWithIntl>) {
  return view.container.ownerDocument.body.textContent ?? "";
}

test("the one-paste command carries --pair, the plain setup and Windows commands don't, and the id stays out of the address and storage", async () => {
  const posts = mockApi({ [CREATE_URL]: () => CREATED, "/computer-pairings/status": () => WAITING, "/computer-pairings/cancel": () => ({ ok: true }) });
  const view = await mountDialog();

  // The channel the one-paste command installs from (tests run as a non-staging
  // build: main): the server pairs only if that channel's Computer takes --pair.
  assert.deepEqual(posts[0], { url: CREATE_URL, body: { channel: "main" } });
  const text = pageText(view);
  assert.ok(text.includes(`sh -s -- --setup /acme --pair=${PAIRING_ID}`), text);
  assert.ok(!text.includes(`raft-computer setup /acme --pair`));

  // The same builder, per form: only the one-paste form ever carries it.
  const commands = getComputerCommands("acme", "production", undefined, { pairingId: PAIRING_ID })!;
  assert.ok(commands.installAndSetup!.endsWith(`--setup /acme --pair=${PAIRING_ID}`));
  assert.ok(!commands.setup.includes("--pair"));
  const windows = getComputerCommands("acme", "production", undefined, { pairingId: PAIRING_ID, platform: "windows" })!;
  assert.equal(windows.installAndSetup, null);
  assert.ok(!windows.setup.includes("--pair") && !windows.install.includes("--pair"));
  // Isolated test deployments have no one-paste form: no --pair at all.
  const staging = getComputerCommands("acme", "staging", undefined, { pairingId: PAIRING_ID })!;
  assert.ok(!JSON.stringify(staging).includes("--pair"));

  assert.ok(!window.location.href.includes(PAIRING_ID));
  for (let i = 0; i < localStorage.length; i += 1) {
    assert.ok(!(localStorage.getItem(localStorage.key(i)!) ?? "").includes(PAIRING_ID));
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    assert.ok(!(sessionStorage.getItem(sessionStorage.key(i)!) ?? "").includes(PAIRING_ID));
  }
});

test("realtime requested: the confirm screen names the machine, approve sends the pairing and its ticket, then success", async () => {
  let state: unknown = WAITING;
  const posts = mockApi({
    [CREATE_URL]: () => CREATED,
    "/computer-pairings/status": () => state,
    "/computer-pairings/approve": () => ({ ok: true, action: "approved" }),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  await mountDialog();

  state = REQUESTED;
  // Another pairing's event is not this window's.
  await emit("computer_pairing:requested", { pairingRef: "someone-elses" });
  assert.equal(posts.filter((post) => post.url === "/computer-pairings/status").length, 0);
  await emit("computer_pairing:requested", { pairingRef: PAIRING_REF });

  assert.deepEqual(posts.find((post) => post.url === "/computer-pairings/status")!.body, { pairingId: PAIRING_ID });
  assert.ok(await screen.findByText("Add “mac-mini” to a server"));
  assert.ok(screen.getByText("mac-mini.lan · Linux x64"));
  assert.ok(screen.getByText("203.0.113.7 · Frankfurt, DE"));
  assert.ok(screen.getByText("VSWA-7M58"));
  assert.ok(screen.getByText("/acme"));
  // No code was typed: nothing to enter differently.
  assert.ok(screen.queryByRole("button", { name: "Enter a different code" }) === null);

  await click(screen.getByRole("button", { name: "Add to server" }));
  assert.deepEqual(posts.find((post) => post.url === "/computer-pairings/approve")!.body, {
    pairingId: PAIRING_ID, approve: true, approvalTicket: "ticket-1",
  });
  assert.ok(posts.every((post) => post.url !== "/auth/device/approve"));
  assert.ok(await screen.findByText("“mac-mini” will be added to Acme. It shows up here once it connects."));
  assert.ok(screen.getByText("Waiting for computer to connect..."));
});

test("two-step verification through the pairing: step up, then the same approval", async () => {
  let approvals = 0;
  const posts = mockApi({
    [CREATE_URL]: () => CREATED,
    "/computer-pairings/status": () => REQUESTED,
    "/computer-pairings/approve": () => {
      approvals += 1;
      if (approvals === 1) failWith("second_factor_step_up_required", { methods: ["totp"] })();
      return { ok: true, action: "approved" };
    },
    "/auth/second-factor/step-up": () => ({ ok: true }),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  const view = await mountDialog();
  await emit("computer_pairing:requested", { pairingRef: PAIRING_REF });
  await click(await screen.findByRole("button", { name: "Add to server" }));

  assert.ok(await screen.findByText("Two-step verification is on for this account. Verify it's you before approving a device login."));
  const field = view.container.ownerDocument.querySelector('input[name="one-time-code"]');
  assert.ok(field);
  fireEvent.change(field, { target: { value: "123456" } });
  await click(screen.getByRole("button", { name: "Verify" }));

  assert.ok(await screen.findByText("“mac-mini” will be added to Acme. It shows up here once it connects."));
  const approves = posts.filter((post) => post.url === "/computer-pairings/approve");
  assert.equal(approves.length, 2);
  assert.deepEqual(approves[1]!.body, { pairingId: PAIRING_ID, approve: true, approvalTicket: "ticket-1" });
});

test("no realtime event: the 10-second status read finds the request", async () => {
  vi.useFakeTimers();
  let state: unknown = WAITING;
  mockApi({ [CREATE_URL]: () => CREATED, "/computer-pairings/status": () => state, "/computer-pairings/cancel": () => ({ ok: true }) });
  await mountDialog();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
  });
  assert.ok(screen.queryByText("Add “mac-mini” to a server") === null);

  state = REQUESTED;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
  });
  assert.ok(screen.getByText("Add “mac-mini” to a server"));
  assert.ok(screen.getByRole("button", { name: "Add to server" }));
});

test("a command used more than once: the request on screen loses its approve, the window says why and shows a new command by itself", async () => {
  let created = 0;
  const posts = mockApi({
    [CREATE_URL]: () => {
      created += 1;
      return created === 1 ? CREATED : { ...CREATED, pairingId: "pair_second", pairingRef: "pairing-row-2" };
    },
    "/computer-pairings/status": () => REQUESTED,
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  const view = await mountDialog();
  await emit("computer_pairing:requested", { pairingRef: PAIRING_REF });
  assert.ok(await screen.findByRole("button", { name: "Add to server" }));

  await emit("computer_pairing:voided", { pairingRef: PAIRING_REF, reason: "conflict" });

  assert.ok(screen.getByText("This command was used more than once, so it can’t be approved here. Copy the new command below."));
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
  assert.ok(screen.queryByRole("button", { name: "Deny" }) === null);
  // A new pairing, and its id in the command; the old one cancelled.
  assert.equal(posts.filter((post) => post.url === CREATE_URL).length, 2);
  assert.ok(pageText(view).includes("--pair=pair_second"));
  assert.ok(!pageText(view).includes(`--pair=${PAIRING_ID}`));
  assert.deepEqual(posts.find((post) => post.url === "/computer-pairings/cancel")!.body, { pairingId: PAIRING_ID });
});

test("the status read finding a conflict also offers no approve", async () => {
  vi.useFakeTimers();
  mockApi({
    [CREATE_URL]: () => CREATED,
    "/computer-pairings/status": () => ({ ...WAITING, state: "conflict" }),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  await mountDialog();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
  });
  assert.ok(screen.getByTestId("add-machine-pairing-conflict"));
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
});

test("approve refused because of a conflict: no approve, the conflict notice, a new command", async () => {
  let created = 0;
  mockApi({
    [CREATE_URL]: () => {
      created += 1;
      return created === 1 ? CREATED : { ...CREATED, pairingId: "pair_second", pairingRef: "pairing-row-2" };
    },
    "/computer-pairings/status": () => REQUESTED,
    "/computer-pairings/approve": failWith("computer_pairing_conflict"),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  const view = await mountDialog();
  await emit("computer_pairing:requested", { pairingRef: PAIRING_REF });
  await click(await screen.findByRole("button", { name: "Add to server" }));

  assert.ok(screen.getByTestId("add-machine-pairing-conflict"));
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
  assert.ok(pageText(view).includes("--pair=pair_second"));
});

for (const [label, fail] of [
  ["not allowed", { status: 403, code: "computer_pairing_not_allowed" }],
  ["the limit", { status: 429, code: "computer_pairing_limit" }],
  ["an older server", { status: 404, code: undefined }],
  ["the channel's Computer predates --pair", { status: 409, code: "computer_pairing_unavailable" }],
] as const) {
  test(`create refused (${label}): today's command without --pair, and the code field still works`, async () => {
    const posts = mockApi({
      [CREATE_URL]: () => {
        throw { response: { status: fail.status, data: fail.code ? { code: fail.code } : {} } };
      },
    });
    const view = await mountDialog();
    const text = pageText(view);
    assert.ok(text.includes("sh -s -- --setup /acme"));
    assert.ok(!text.includes("--pair"));
    assert.ok(screen.getByRole("button", { name: "The terminal shows a code? Enter it here." }));
    assert.deepEqual(posts.map((post) => post.url), [CREATE_URL]);
  });
}

test("renewed on a timer while open, cancelled on close", async () => {
  vi.useFakeTimers();
  const posts = mockApi({
    [CREATE_URL]: () => CREATED,
    "/computer-pairings/status": () => WAITING,
    "/computer-pairings/renew": () => ({ expiresAt: CREATED.expiresAt }),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  const view = await mountDialog();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_RENEW_MS);
  });
  const renews = posts.filter((post) => post.url === "/computer-pairings/renew");
  assert.equal(renews.length, 1);
  assert.deepEqual(renews[0]!.body, { pairingId: PAIRING_ID });
  assert.ok(posts.every((post) => post.url !== "/computer-pairings/cancel"));

  await act(async () => {
    view.unmount();
  });
  assert.deepEqual(posts.filter((post) => post.url === "/computer-pairings/cancel").map((post) => post.body), [{ pairingId: PAIRING_ID }]);
  // Nothing after the window closed.
  const count = posts.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_RENEW_MS);
  });
  assert.equal(posts.length, count);
});

test("an expired pairing is quietly replaced by a new command", async () => {
  vi.useFakeTimers();
  let created = 0;
  const posts = mockApi({
    [CREATE_URL]: () => {
      created += 1;
      return created === 1 ? CREATED : { ...CREATED, pairingId: "pair_second", pairingRef: "pairing-row-2" };
    },
    "/computer-pairings/status": () => ({ ...WAITING, state: created === 1 ? "expired" : "waiting" }),
    "/computer-pairings/cancel": () => ({ ok: true }),
  });
  const view = await mountDialog();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
  });
  assert.equal(posts.filter((post) => post.url === CREATE_URL).length, 2);
  assert.ok(pageText(view).includes("--pair=pair_second"));
  assert.ok(screen.queryByTestId("add-machine-pairing-conflict") === null);
});
