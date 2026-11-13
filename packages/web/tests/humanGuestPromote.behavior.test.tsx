import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HumanDetailPanel from "../src/components/member/HumanDetailPanel";
import type { HumanProfile } from "../src/components/member/HumanDetailPanel";
import { setToastManager } from "../src/components/toastBridge";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useChannelStore } from "../src/store/channelStore";

// Guest design D1/D2: a Guest's profile names its channel, and an owner or
// admin promotes it from the profile, after a one-sentence confirmation.

type Toast = { title: string; actionProps?: { children: string } };
let toasts: Toast[] = [];

beforeEach(() => {
  toasts = [];
  setToastManager({ add: (toast) => { toasts.push(toast as Toast); } });
});

afterEach(() => {
  cleanup();
  setToastManager(null);
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState({ dmChannels: [] } as never);
});

function guest(overrides: Partial<HumanProfile> = {}): HumanProfile {
  return {
    userId: "user-lena", serverId: "server-1", serverName: "Acme", serverSlug: "acme",
    email: "lena@contoso.com", name: "lena", displayName: "Lena Park",
    description: null, avatarUrl: null, role: "guest", joinedAt: "2026-10-21T00:00:00.000Z",
    membershipStatus: "active", createdAgents: [],
    guestChannel: { id: "channel-launch", name: "launch-plan" },
    ...overrides,
  };
}

function seed(viewerRole: "owner" | "admin" | "member", saves: string[] = []) {
  useAuthStore.setState({ user: { id: "viewer-1", name: "alice" }, loading: false, initialized: true } as never);
  useServerStore.setState({
    current: { id: "server-1", name: "Acme", slug: "acme", role: viewerRole },
    members: [
      { userId: "viewer-1", role: viewerRole },
      { userId: "owner-2", role: "owner" },
      { userId: "user-lena", role: "guest" },
    ],
    loading: false,
    updateMemberRole: async (userId: string, role: string) => { saves.push(`${userId}:${role}`); },
  } as never);
}

function renderPanel(human: HumanProfile) {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <HumanDetailPanel human={human} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("a Guest's profile names its channel: Channel · Guest in #channel", () => {
  seed("owner");
  renderPanel(guest());
  assert.ok(screen.getByText("Channel"));
  assert.ok(screen.getByText("Guest in #launch-plan"));
});

test("no channel row when the viewer may not see the Guest's channel", () => {
  seed("owner");
  renderPanel(guest({ guestChannel: null }));
  assert.ok(screen.queryByText(/Guest in #/) === null);
});

for (const viewerRole of ["owner", "admin"] as const) {
  test(`an ${viewerRole} promotes a Guest from its profile after the confirmation`, async () => {
    const saves: string[] = [];
    seed(viewerRole, saves);
    renderPanel(guest());

    fireEvent.click(screen.getByRole("button", { name: "Promote to server member" }));
    assert.ok(await screen.findByText("Make Lena Park a member of Acme?"));
    assert.ok(screen.getByText("They'll get access to Acme like other members and take one seat."));
    assert.deepEqual(saves, [], "nothing changes before the confirmation");
    fireEvent.click(screen.getByRole("button", { name: "Make member" }));

    await waitFor(() => assert.deepEqual(saves, ["user-lena:member"]));
    await waitFor(() => assert.equal(toasts.length, 1));
    assert.equal(toasts[0]!.title, "Changed Lena Park's role to Member");
    assert.equal(toasts[0]!.actionProps, undefined, "no Undo: a member is never made a Guest again");
  });
}

test("Cancel leaves the Guest as it was", async () => {
  const saves: string[] = [];
  seed("owner", saves);
  renderPanel(guest());
  fireEvent.click(screen.getByRole("button", { name: "Promote to server member" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByText("Make Lena Park a member of Acme?") === null));
  assert.deepEqual(saves, []);
});

test("a member sees no Promote action on a Guest", () => {
  seed("member");
  renderPanel(guest());
  assert.ok(screen.queryByRole("button", { name: "Promote to server member" }) === null);
});

test("Promote is only on a Guest's profile, not on a member's", () => {
  seed("owner");
  renderPanel(guest({ role: "member", guestChannel: undefined }));
  assert.ok(screen.queryByRole("button", { name: "Promote to server member" }) === null);
  assert.ok(screen.queryByText(/Guest in #/) === null);
});

for (const viewerRole of ["owner", "admin"] as const) {
  test(`an ${viewerRole} can remove a Guest (design D1)`, () => {
    seed(viewerRole);
    renderPanel(guest());
    assert.ok(screen.getByRole("button", { name: "Remove member" }));
  });
}

test("a member cannot remove a Guest", () => {
  seed("member");
  renderPanel(guest());
  assert.ok(screen.queryByRole("button", { name: "Remove member" }) === null);
});

test("Promote sits above Remove Member in Actions (design D2)", () => {
  seed("owner");
  renderPanel(guest());
  const promote = screen.getByRole("button", { name: "Promote to server member" });
  const remove = screen.getByRole("button", { name: "Remove member" });
  assert.ok(promote.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING, "Promote comes before Remove");
});

test("promoting a Guest from the Role picker offers no Undo either", async () => {
  const saves: string[] = [];
  seed("owner", saves);
  renderPanel(guest());
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  fireEvent.click(await screen.findByText("Member"));
  await waitFor(() => assert.deepEqual(saves, ["user-lena:member"]));
  await waitFor(() => assert.equal(toasts.length, 1));
  assert.equal(toasts[0]!.actionProps, undefined, "no Undo back to Guest");
});

test("a promotion refused at the Raft License's user limit says so under the role, with the mail link", async () => {
  seed("owner");
  useServerStore.setState({
    updateMemberRole: async () => {
      throw Object.assign(new Error("http"), { response: { status: 403, data: { code: "deployment_user_limit_reached", error: "server sentence" } } });
    },
  } as never);
  renderPanel(guest());
  fireEvent.click(screen.getByRole("button", { name: "Promote to server member" }));
  fireEvent.click(await screen.findByRole("button", { name: "Make member" }));
  const error = await screen.findByTestId("human-role-error");
  assert.match(error.textContent ?? "", /This Raft Community Edition deployment already has 5 people, the Raft License limit\./);
  const link = screen.getByRole("link", { name: "contact@raft.build" });
  assert.ok(error.contains(link) && link.getAttribute("href") === "mailto:contact@raft.build");
  assert.equal(toasts.length, 0);
});
