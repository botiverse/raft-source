import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import AboutFeedbackPanel, {
  feedbackWorkspaceBasePath,
  feedbackWorkspacePath,
  feedbackWorkspaceRouteFromPath,
} from "../src/components/settings/AboutFeedbackDialog";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import api from "../src/api/client";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import { useServerStore } from "../src/store/serverStore";

const originalApiGet = api.get;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalAnchorClick = HTMLAnchorElement.prototype.click;
function matchMediaStub(matches: boolean): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const originalMatchMedia =
  typeof window.matchMedia === "function"
    ? window.matchMedia
    : matchMediaStub(false);
window.matchMedia = originalMatchMedia;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  window.matchMedia = originalMatchMedia;
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
  window.localStorage.clear();
});

function providers(children: ReactNode) {
  return (
    <LocaleProvider>
      <IntlProviderWrapper>{children}</IntlProviderWrapper>
    </LocaleProvider>
  );
}

function mockEmptyInbox() {
  api.get = (async (url: string) => {
    assert.equal(url, "/product-feedback/tickets");
    return { data: { tickets: [], next_cursor: null, unread_total: 0 } };
  }) as typeof api.get;
}

function renderAbout() {
  useServerStore.setState({
    current: { id: "server-1", name: "Raft Test", slug: "raft-test" },
    servers: [],
    members: [],
  } as never);
  return render(providers(
    <MemoryRouter>
      <SettingsPanel tab="about" />
    </MemoryRouter>,
  ));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="feedback-location">{location.pathname}</output>;
}

function renderFeedbackPanel(
  initialEntry = "/s/raft-test/settings/feedback",
) {
  useServerStore.setState({
    current: { id: "server-1", name: "Raft Test", slug: "raft-test" },
    servers: [],
    members: [],
  } as never);
  return render(providers(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AboutFeedbackPanel />
      <LocationProbe />
    </MemoryRouter>,
  ));
}

function setMobileViewport(matches: boolean) {
  window.matchMedia = matchMediaStub(matches);
}

test("About content does not duplicate the Settings sidebar Feedback action", () => {
  renderAbout();
  assert.equal(screen.queryByRole("button", { name: /Feedback/i }), null);
  assert.equal(screen.queryByRole("dialog", { name: /My feedback/i }), null);
});

test("feedback entry renders the real Hands SDK inbox and new-feedback route", async () => {
  mockEmptyInbox();
  renderFeedbackPanel();

  assert.equal(screen.queryByRole("dialog"), null);
  assert.ok(await screen.findByRole("heading", { name: "My Feedback" }));
  fireEvent.click(screen.getByRole("button", { name: "New feedback" }));
  assert.ok(screen.getByRole("heading", { name: "New feedback" }));
  assert.ok(screen.getByRole("textbox", { name: "What would you like us to know?" }));
});

test("pending feedback images open the shared Lightbox without an API read", async () => {
  mockEmptyInbox();
  const calls: string[] = [];
  const previousGet = api.get;
  api.get = (async (url: string) => {
    calls.push(url);
    return previousGet(url);
  }) as typeof api.get;
  URL.createObjectURL = (() => "blob:pending-feedback") as typeof URL.createObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
  renderFeedbackPanel();

  fireEvent.click(await screen.findByRole("button", { name: "New feedback" }));
  const file = new File(["image"], "pending.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open attachment pending.png",
    }),
  );

  assert.ok(await screen.findByRole("button", { name: "Download" }));
  assert.equal(
    screen.getByRole("img", { name: "pending.png" }).getAttribute("src"),
    "blob:pending-feedback",
  );
  assert.deepEqual(calls, ["/product-feedback/tickets"]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("button", { name: "Download" }), null),
  );
  assert.deepEqual(revoked, ["blob:pending-feedback"]);
});

test("feedback mobile detail and create views use real URLs with a working Back path", async () => {
  setMobileViewport(true);
  const ticketId = "33333333-3333-4333-8333-333333333333";
  let listReads = 0;
  let detailReads = 0;
  api.get = (async (url: string) => {
    if (url === "/product-feedback/tickets") {
      listReads += 1;
      return {
        data: {
          tickets: [{
            id: ticketId,
            kind: "feedback",
            status: "open",
            message: "Mobile route feedback",
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            unread: false,
            unread_count: 0,
            attachment_count: 0,
            comment_count: 0,
          }],
          next_cursor: null,
          unread_total: 0,
        },
      };
    }
    if (url === `/product-feedback/tickets/${ticketId}`) {
      detailReads += 1;
      return {
        data: {
          ticket: {
            id: ticketId,
            kind: "feedback",
            status: "open",
            message: "Mobile route feedback",
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            unread: false,
            unread_count: 0,
            attachment_count: 0,
            comment_count: 0,
          },
          comments: [],
          attachments: [],
          next_comment_cursor: null,
          unread_total: 0,
        },
      };
    }
    assert.fail(`Unexpected feedback URL: ${url}`);
  }) as typeof api.get;

  renderFeedbackPanel();
  const ticketButton = await screen.findByRole("button", {
    name: "Mobile route feedback",
  });
  const listViewport = document.querySelector<HTMLElement>(
    "[data-feedback-list-scroll]",
  )!;
  fireEvent.touchStart(listViewport, { touches: [{ clientY: 0 }] });
  fireEvent.touchMove(listViewport, {
    cancelable: true,
    touches: [{ clientY: 180 }],
  });
  fireEvent.touchEnd(listViewport, { changedTouches: [{ clientY: 180 }] });
  await waitFor(() => assert.equal(listReads, 2));

  fireEvent.click(ticketButton);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("feedback-location").textContent,
      `/s/raft-test/settings/feedback/ticket/${ticketId}`,
    ),
  );
  const conversation = await screen.findByLabelText("Conversation");
  fireEvent.touchStart(conversation, { touches: [{ clientY: 0 }] });
  fireEvent.touchMove(conversation, {
    cancelable: true,
    touches: [{ clientY: 180 }],
  });
  fireEvent.touchEnd(conversation, { changedTouches: [{ clientY: 180 }] });
  await waitFor(() => assert.equal(detailReads, 2));

  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("feedback-location").textContent,
      "/s/raft-test/settings/feedback",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "New feedback" }));
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("feedback-location").textContent,
      "/s/raft-test/settings/feedback/new",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("feedback-location").textContent,
      "/s/raft-test/settings/feedback",
    ),
  );
});

test("feedback route helpers preserve the settings base and encode ticket ids", () => {
  const base = "/s/dev/settings/feedback";
  assert.equal(
    feedbackWorkspaceBasePath(`${base}/ticket/ticket%2Fone`),
    base,
  );
  assert.deepEqual(
    feedbackWorkspaceRouteFromPath(`${base}/ticket/ticket%2Fone`),
    { view: "ticket", ticketId: "ticket/one" },
  );
  assert.deepEqual(feedbackWorkspaceRouteFromPath(`${base}/new`), {
    view: "new",
  });
  assert.equal(
    feedbackWorkspacePath(base, { view: "ticket", ticketId: "ticket/one" }),
    `${base}/ticket/ticket%2Fone`,
  );
});

test("feedback settings renders one shared page header instead of nested settings chrome", async () => {
  mockEmptyInbox();
  render(providers(
    <MemoryRouter>
      <SettingsPanel tab="feedback" />
    </MemoryRouter>,
  ));

  await screen.findByRole("heading", { name: "My Feedback" });
  assert.equal(screen.queryByTestId("settings-panel-header"), null);
  assert.equal(
    screen.getAllByRole("heading", { name: "My Feedback" }).length,
    1,
  );
  assert.equal(
    screen.getAllByRole("button", { name: "New feedback" }).length,
    1,
  );
});

test("feedback workspace follows the explicit Raft display locale", async () => {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "zh-cn");
  mockEmptyInbox();
  renderFeedbackPanel();

  assert.equal(screen.queryByRole("dialog"), null);
  assert.ok(await screen.findByRole("heading", { name: "我的反馈" }));
  assert.equal(screen.getAllByRole("button", { name: "新建反馈" }).length, 1);
});

test("feedback image attachments open an authenticated Lightbox before download", async () => {
  const ticketId = "33333333-3333-4333-8333-333333333333";
  const attachmentId = "55555555-5555-4555-8555-555555555555";
  const attachment = new Blob(["image"], { type: "image/png" });
  const calls: string[] = [];

  api.get = (async (url: string) => {
    calls.push(url);
    if (url === "/product-feedback/tickets") {
      return {
        data: {
          tickets: [{
            id: ticketId,
            kind: "feedback",
            status: "open",
            message: "Please inspect the screenshot.",
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            unread: false,
            unread_count: 0,
            attachment_count: 1,
            comment_count: 0,
          }],
          next_cursor: null,
          unread_total: 0,
        },
      };
    }
    if (url === `/product-feedback/tickets/${ticketId}`) {
      return {
        data: {
          ticket: {
            id: ticketId,
            kind: "feedback",
            status: "open",
            message: "Please inspect the screenshot.",
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            unread: false,
            unread_count: 0,
            attachment_count: 1,
            comment_count: 0,
          },
          comments: [],
          attachments: [{
            id: attachmentId,
            filename: "screen.png",
            content_type: "image/png",
            size_bytes: attachment.size,
            created_at: 1_700_000_000_000,
          }],
          next_comment_cursor: null,
          unread_total: 0,
        },
      };
    }
    assert.equal(
      url,
      `/product-feedback/tickets/${ticketId}/attachments/${attachmentId}`,
    );
    return {
      data: attachment,
      headers: { "content-disposition": 'attachment; filename="screen.png"' },
    };
  }) as typeof api.get;

  const revoked: string[] = [];
  URL.createObjectURL = (() => "blob:feedback-attachment") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
  let clicked: HTMLAnchorElement | null = null;
  HTMLAnchorElement.prototype.click = function click() {
    clicked = this;
  };

  renderFeedbackPanel();
  fireEvent.click(await screen.findByRole("button", { name: /Please inspect the screenshot/ }));
  const thumbnail = await screen.findByRole("img", { name: "screen.png" });
  fireEvent.click(thumbnail);
  assert.ok(await screen.findByRole("button", { name: "Download" }));
  const toolbar = document.querySelector('[data-slot="lightbox-toolbar"]');
  assert.ok(toolbar instanceof HTMLElement);
  assert.ok(toolbar.className.includes("bg-white"));

  assert.equal(clicked, null);
  assert.deepEqual(calls, [
    "/product-feedback/tickets",
    `/product-feedback/tickets/${ticketId}`,
    `/product-feedback/tickets/${ticketId}/attachments/${attachmentId}`,
    `/product-feedback/tickets/${ticketId}/attachments/${attachmentId}`,
  ]);
  assert.deepEqual(revoked, []);

  fireEvent.click(screen.getByRole("button", { name: "Download" }));

  assert.ok(clicked);
  assert.equal(clicked.target, "");
  assert.equal(clicked.rel, "");
  assert.equal(clicked.download, "screen.png");
  assert.equal(clicked.href, "blob:feedback-attachment");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => {
    assert.equal(screen.queryByRole("button", { name: "Download" }), null);
    assert.equal(screen.getAllByRole("img", { name: "screen.png" }).length, 1);
  });
  assert.deepEqual(revoked, ["blob:feedback-attachment"]);
});
