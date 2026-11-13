import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import api from "../src/api/client";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import { useAuthStore } from "../src/store/authStore";
// DeviceLoginPage now calls useIntl() (pages.deviceLogin.* migration), so it
// needs an <IntlProvider> ancestor. Default locale (en) keeps these English
// assertions green.
import { TestIntlProvider } from "./helpers/intl";

const originalPost = api.post;
const originalClose = window.close;

function resetAuthUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "cindy@example.com",
      name: "cindy zhao",
      displayName: "cindy zhao",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
}

type Post = { url: string; body: unknown };

const REQUEST = {
  userCode: "VSWA-7M58",
  clientName: "raft-computer",
  requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  requester: { ip: null, location: null },
  approvalTicket: "ticket-1",
};

const SELF_REPORTED = "The program sends this name itself. Whoever started this login can set it to anything.";

function mockApi(handlers: { describe?: () => unknown; approve?: () => unknown }): Post[] {
  const posts: Post[] = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    const handler = url === "/auth/device/describe" ? handlers.describe : handlers.approve;
    if (!handler) throw new Error(`unexpected POST ${url}`);
    return { data: handler() };
  }) as typeof api.post;
  return posts;
}

function failWith(code: string) {
  return () => {
    throw { response: { data: { code } } };
  };
}

async function typeCodeAndContinue(code = "vswa-7m58") {
  fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
}

function renderPage(search = "") {
  window.history.pushState({}, "", `/login/device${search}`);
  resetAuthUser();
  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
}

afterEach(() => {
  cleanup();
  api.post = originalPost;
  window.close = originalClose;
  window.history.pushState({}, "", "/");
  resetAuthUser();
});

test("a code in the link is never filled in, and is dropped from the address", async () => {
  const posts = mockApi({});
  renderPage("?user_code=VSWA-7M58");

  const input = screen.getByPlaceholderText("XXXX-XXXX") as HTMLInputElement;
  assert.equal(input.value, "");
  await waitFor(() => assert.equal(window.location.search, ""));
  assert.equal((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(posts, []);
});

for (const [code, text] of [
  ["expired", "That code has expired. Start the login again."],
  ["user_code_invalid", "That code is invalid. Check the code shown where you started this login and try again."],
  ["already_resolved", "That login request was already approved or denied. Start the login again if needed."],
] as const) {
  test(`a typed code that can't be approved (${code}) says why, before any approval`, async () => {
    const posts = mockApi({ describe: failWith(code) });
    renderPage();
    await typeCodeAndContinue();

    assert.ok(await screen.findByText(text));
    assert.ok(screen.queryByText(/Raft Desktop\./) === null);
    assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
  });
}

test("before approving, the page shows who asked and warns against approving someone else's login", async () => {
  const posts = mockApi({ describe: () => ({ ...REQUEST, clientName: "Raft official security check" }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: "Is this login yours?" }));
  assert.deepEqual(posts, [{ url: "/auth/device/describe", body: { userCode: "VSWA-7M58" } }]);
  assert.ok(screen.getByText("VSWA-7M58"));
  assert.ok(screen.getByText(/If someone sent you this code or a link to this page, or asked you to approve it, deny it/));
  // The name exactly as given, quoted, with the note that anyone can set it.
  assert.ok(screen.getByText("“Raft official security check”"));
  assert.ok(screen.getByText(SELF_REPORTED));
  assert.ok(screen.getByText("Can't be determined"));
  assert.ok(screen.getByText(/2 minutes ago/));
});

test("no name earns a friendlier label: Raft's own client names are quoted as given too", async () => {
  mockApi({ describe: () => ({ ...REQUEST, requester: { ip: "203.0.113.7", location: "São Paulo, Sao Paulo, BR" } }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByText("“raft-computer”"));
  assert.ok(screen.queryByText("Raft Computer") === null, "no friendly label for a self-reported name");
  assert.ok(screen.getByText(SELF_REPORTED));
  assert.ok(screen.getByText("203.0.113.7 · São Paulo, Sao Paulo, BR"));
});

for (const name of ["constructor", "__proto__", "toString"]) {
  test(`a client name like ${name} is shown as text, like any other`, async () => {
    mockApi({ describe: () => ({ ...REQUEST, clientName: name }) });
    renderPage();
    await typeCodeAndContinue();

    assert.ok(await screen.findByText(`“${name}”`));
    assert.ok(screen.getByText(SELF_REPORTED));
  });
}

test("a login that gave no name says so", async () => {
  mockApi({ describe: () => ({ ...REQUEST, clientName: null }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByText("Not given"));
  assert.ok(screen.getByText(SELF_REPORTED));
});

test("Enter a Different Code goes back to an empty code field", async () => {
  const posts = mockApi({ describe: () => REQUEST });
  renderPage();
  await typeCodeAndContinue();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Enter a different code" }));
  });

  assert.equal((screen.getByPlaceholderText("XXXX-XXXX") as HTMLInputElement).value, "");
  assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
});

test("approving the checked code finishes, and the page offers to close", async () => {
  let closed = false;
  window.close = () => {
    closed = true;
  };
  const posts = mockApi({ describe: () => REQUEST, approve: () => ({ ok: true, action: "approved" }) });
  renderPage();
  await typeCodeAndContinue();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Approve device login" }));
  });

  assert.ok(await screen.findByText("Sign-in is complete. You can close this browser page."));
  // Approving carries describe's ticket: the server refuses an approve without one.
  assert.deepEqual(posts[1], { url: "/auth/device/approve", body: { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close this page" }));
  });
  await waitFor(() => assert.equal(closed, true));
  assert.ok(await screen.findByText("If this tab stays open, close it manually."));
});

test("denying sends approve: false and says nothing was given access", async () => {
  const posts = mockApi({ describe: () => REQUEST, approve: () => ({ ok: true, action: "denied" }) });
  renderPage();
  await typeCodeAndContinue();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  });

  assert.ok(await screen.findByText("Nothing was given access to your account. You can close this browser page."));
  assert.deepEqual(posts[1], { url: "/auth/device/approve", body: { userCode: "VSWA-7M58", approve: false } });
});

test("a code that expires between checking and approving goes back to typing a code", async () => {
  mockApi({ describe: () => REQUEST, approve: failWith("expired") });
  renderPage();
  await typeCodeAndContinue();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Approve device login" }));
  });

  assert.ok(await screen.findByText("That code has expired. Start the login again."));
  assert.ok(screen.getByPlaceholderText("XXXX-XXXX"));
});

test("a deny that fails says the login couldn't be denied, not approved", async () => {
  mockApi({ describe: () => REQUEST, approve: () => {
    throw { response: { data: {} } };
  } });
  renderPage();
  await typeCodeAndContinue();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  });

  assert.ok(await screen.findByText("Device login could not be denied."));
});

// One-time grants: the login asks for one thing (add this machine to a server,
// or a key for an agent), and the person picks where. Never preselected.

const ALPHA = { id: "11111111-1111-4111-8111-111111111111", slug: "alpha", name: "Alpha Co" };
const BETA = { id: "22222222-2222-4222-8222-222222222222", slug: "beta", name: "Beta Labs" };
const ATTACH_REQUEST = {
  ...REQUEST,
  grant: { kind: "computer_attach", machineName: "Maria's laptop", hostname: "maria-mbp", os: "macOS", servers: [ALPHA, BETA] },
};
const SCOUT = { id: "33333333-3333-4333-8333-333333333333", name: "scout", displayName: "Scout", serverId: ALPHA.id, serverName: "Alpha Co" };
const AGENT_KEY_REQUEST = {
  ...REQUEST,
  grant: { kind: "agent_key", machineName: "ci-runner", hostname: null, os: null, requestedAgentId: SCOUT.id, agents: [SCOUT] },
};

function approveButton(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

test("a login without a grant shows no picker and asks to approve the login, as before", async () => {
  mockApi({ describe: () => REQUEST });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: "Is this login yours?" }));
  assert.ok(screen.queryByRole("radiogroup") === null);
  assert.equal(approveButton("Approve device login").disabled, false);
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
});

test("computer_attach: says which machine, lists only the returned servers, and approves only after a pick", async () => {
  const posts = mockApi({ describe: () => ATTACH_REQUEST, approve: () => ({ ok: true, action: "approved" }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: "Add “Maria's laptop” to a server" }));
  assert.ok(screen.getByText("maria-mbp · macOS"));
  assert.ok(screen.getByText(/approving adds their computer to the server you pick/));
  const group = screen.getByRole("radiogroup", { name: "Server" });
  const radios = screen.getAllByRole("radio");
  assert.equal(radios.length, 2);
  assert.ok(group.textContent?.includes("Alpha Co"));
  assert.ok(group.textContent?.includes("/beta"));
  assert.ok(radios.every((radio) => radio.getAttribute("aria-checked") === "false"), "nothing preselected");
  assert.equal(approveButton("Add to server").disabled, true);

  await click(screen.getByRole("radio", { name: /Beta Labs/ }));
  assert.equal(approveButton("Add to server").disabled, false);
  await click(approveButton("Add to server"));

  assert.deepEqual(posts[1], {
    url: "/auth/device/approve",
    body: { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1", serverId: BETA.id },
  });
  assert.ok(await screen.findByRole("heading", { name: "Computer approved" }));
  assert.ok(screen.getByText("“Maria's laptop” will be added to Beta Labs. You can close this browser page."));
  assert.ok(screen.queryByText("Sign-in is complete. You can close this browser page.") === null);
});

test("computer_migrate: says it moves the old connection, picks a server like an attach, approves only after a pick", async () => {
  const posts = mockApi({
    describe: () => ({ ...REQUEST, grant: { ...ATTACH_REQUEST.grant, kind: "computer_migrate" } }),
    approve: () => ({ ok: true, action: "approved" }),
  });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: "Move “Maria's laptop” to Raft Computer" }));
  assert.ok(screen.getByText(/take over an old Raft connection on the server you pick, yours or another member's/));
  assert.equal(screen.getAllByRole("radio").length, 2);
  assert.equal(approveButton("Move it over").disabled, true);
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);

  await click(screen.getByRole("radio", { name: /Alpha Co/ }));
  await click(approveButton("Move it over"));

  assert.deepEqual(posts[1], {
    url: "/auth/device/approve",
    body: { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1", serverId: ALPHA.id },
  });
  assert.ok(await screen.findByRole("heading", { name: "Move approved" }));
  assert.ok(screen.getByText("“Maria's laptop” can now move its old connection to Alpha Co over. You can close this browser page."));
});

test("computer_attach with one server still waits for the person to pick it", async () => {
  mockApi({ describe: () => ({ ...ATTACH_REQUEST, grant: { ...ATTACH_REQUEST.grant, servers: [ALPHA] } }) });
  renderPage();
  await typeCodeAndContinue();

  const radio = await screen.findByRole("radio", { name: /Alpha Co/ });
  assert.equal(radio.getAttribute("aria-checked"), "false");
  assert.equal(approveButton("Add to server").disabled, true);
});

test("a machine name is shown as plain text, never as markup or a link", async () => {
  const name = "<a href=\"https://evil.example\">Raft support</a>";
  mockApi({ describe: () => ({ ...ATTACH_REQUEST, grant: { ...ATTACH_REQUEST.grant, machineName: name } }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: `Add “${name}” to a server` }));
  assert.ok(screen.getByText(`“${name}”`));
  assert.ok(document.querySelector("a[href='https://evil.example']") === null, "the name is never parsed as markup");
  assert.ok(screen.getByText("The computer sends its name and details itself. Whoever started this login can set them to anything."));
});

test("computer_attach with no server to add machines to explains why and offers only deny", async () => {
  const posts = mockApi({
    describe: () => ({ ...ATTACH_REQUEST, grant: { ...ATTACH_REQUEST.grant, servers: [] } }),
    approve: () => ({ ok: true, action: "denied" }),
  });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByText(/You can't add computers to any of your servers/));
  assert.ok(screen.queryByRole("radiogroup") === null);
  assert.ok(screen.queryByRole("button", { name: "Add to server" }) === null);
  await click(screen.getByRole("button", { name: "Deny" }));
  assert.deepEqual(posts[1], { url: "/auth/device/approve", body: { userCode: "VSWA-7M58", approve: false } });
  assert.ok(await screen.findByText("Nothing was given access to your account. You can close this browser page."));
});

test("agent_key: names the requester, lists the agents, sends the picked agentId and says a key is on its way", async () => {
  const posts = mockApi({ describe: () => AGENT_KEY_REQUEST, approve: () => ({ ok: true, action: "approved" }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByRole("heading", { name: "Give “ci-runner” a key for an agent" }));
  assert.ok(screen.getByRole("radiogroup", { name: "Agent" }));
  // The agent the client asked for is a hint, never the pick.
  const radio = screen.getByRole("radio", { name: /Scout/ });
  assert.equal(radio.getAttribute("aria-checked"), "false");
  assert.ok(screen.getByText("scout · Alpha Co"));
  assert.equal(approveButton("Give key").disabled, true);

  await click(radio);
  await click(approveButton("Give key"));

  assert.deepEqual(posts[1], {
    url: "/auth/device/approve",
    body: { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1", agentId: SCOUT.id },
  });
  assert.ok(await screen.findByRole("heading", { name: "Key approved" }));
  assert.ok(screen.getByText("“ci-runner” will get a key for Scout. You can close this browser page."));
});

test("agent_key with no agent to key explains why and offers no approve", async () => {
  mockApi({ describe: () => ({ ...AGENT_KEY_REQUEST, grant: { ...AGENT_KEY_REQUEST.grant, agents: [] } }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByText(/There's no agent you can give a key to/));
  assert.ok(screen.queryByRole("button", { name: "Give key" }) === null);
  assert.ok(screen.getByRole("button", { name: "Deny" }));
});

for (const [request, code, text, button] of [
  [ATTACH_REQUEST, "grant_selection_not_allowed", "You can't add computers to that server. Choose another one.", "Add to server"],
  [ATTACH_REQUEST, "grant_selection_required", "Choose a server first.", "Add to server"],
  [AGENT_KEY_REQUEST, "grant_selection_not_allowed", "You can't give that agent a key. Choose another one.", "Give key"],
  [AGENT_KEY_REQUEST, "grant_selection_required", "Choose an agent first.", "Give key"],
] as const) {
  test(`${request.grant.kind}: ${code} keeps the page open, clears the pick and says what to do`, async () => {
    mockApi({ describe: () => request, approve: failWith(code) });
    renderPage();
    await typeCodeAndContinue();
    await click((await screen.findAllByRole("radio"))[0]!);
    await click(approveButton(button));

    assert.ok(await screen.findByText(text));
    assert.ok(screen.getByRole("radiogroup"));
    assert.ok(screen.getAllByRole("radio").every((radio) => radio.getAttribute("aria-checked") === "false"));
    assert.equal(approveButton(button).disabled, true);
  });
}

test("grant_kind_unsupported on approve goes back to typing a code and says so", async () => {
  mockApi({ describe: () => ATTACH_REQUEST, approve: failWith("grant_kind_unsupported") });
  renderPage();
  await typeCodeAndContinue();
  await click(await screen.findByRole("radio", { name: /Alpha Co/ }));
  await click(approveButton("Add to server"));

  assert.ok(await screen.findByText(/This kind of device login isn't supported here/));
  assert.ok(screen.getByPlaceholderText("XXXX-XXXX"));
});

test("a grant kind this page doesn't know is refused before anything can be approved", async () => {
  const posts = mockApi({ describe: () => ({ ...REQUEST, grant: { kind: "computer_adopt", machineName: "old", hostname: null, os: null } }) });
  renderPage();
  await typeCodeAndContinue();

  assert.ok(await screen.findByText(/This kind of device login isn't supported here/));
  assert.ok(screen.getByPlaceholderText("XXXX-XXXX"));
  assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe"]);
});
