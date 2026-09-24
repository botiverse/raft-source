// @ts-nocheck
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();
const originalWindowOpen = window.open;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname}</output>;
}

function setBrowserLanguages(languages: string[]) {
  Object.defineProperty(window.navigator, "languages", {
    configurable: true,
    value: languages,
  });
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: languages[0] ?? "en-US",
  });
}

function renderRail({
  workspaceModeAvailable = false,
  feedbackEnabled = true,
  joinCommunityServer = originalServerState.joinCommunityServer,
  languages = ["en-US"],
}: {
  workspaceModeAvailable?: boolean;
  feedbackEnabled?: boolean;
  joinCommunityServer?: typeof originalServerState.joinCommunityServer;
  languages?: string[];
} = {}) {
  setBrowserLanguages(languages);
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: null,
    } as never,
    servers: [{
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: null,
    } as never],
    settings: {
      ...originalServerState.settings,
      feedbackSettings: { enabled: feedbackEnabled },
    } as never,
    joinCommunityServer,
  });
  return render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" workspaceModeAvailable={workspaceModeAvailable} />
        <LocationProbe />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  setBrowserLanguages(["en-US"]);
  api.get = originalApiGet;
  window.open = originalWindowOpen;
  useServerStore.setState(originalServerState, true);
});

test("Help sits above Settings and exposes Raft Documentation, Feedback, and Join Community", async () => {
  renderRail({ workspaceModeAvailable: true });

  const help = screen.getByRole("button", { name: "Help" });
  const settings = screen.getByRole("button", { name: "Settings" });
  const notification = screen.getByTestId("notification-trigger-rail");
  const workspace = screen.getByTestId("workspace-mode-toggle");
  const rail = screen.getByTestId("workspace-left-rail");

  assert.match(rail.className, /\bhidden\b/);
  assert.match(rail.className, /\bmd:flex\b/, "the rail, including Help, is desktop-only");
  assert.equal(rail.contains(help), true);
  for (const button of [notification, help, workspace, settings]) {
    assert.match(button.className, /\bsize-10\b/, `${button.getAttribute("aria-label")} keeps a 40px target`);
    assert.equal(
      button.parentElement?.classList.contains("h-11"),
      true,
      `${button.getAttribute("aria-label")} keeps the 44px center rhythm`,
    );
  }
  assert.ok(
    help.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    "Help must render before Settings in the bottom rail",
  );
  assert.equal(screen.queryByRole("menu", { name: "Help & resources" }), null);

  await act(async () => {
    fireEvent.click(help);
    await Promise.resolve();
  });

  assert.ok(screen.getByRole("menu", { name: "Help & resources" }));
  const documentation = screen.getByRole("menuitem", { name: "Raft Documentation" });
  const feedback = screen.getByRole("menuitem", { name: "Feedback" });
  const community = screen.getByRole("menuitem", { name: "Join Community" });
  assert.equal(documentation.querySelectorAll("svg").length, 2, "Documentation keeps its external-link icon");
  assert.equal(feedback.querySelectorAll("svg").length, 1, "Feedback has only its leading icon");
  assert.equal(community.querySelectorAll("svg").length, 1, "Community has only its leading icon");
  assert.equal(help.getAttribute("aria-expanded"), "true");

  act(() => {
    fireEvent.click(feedback);
  });
  assert.equal(screen.getByTestId("location-probe").textContent, "/s/botiverse/settings/feedback");
  assert.equal(screen.queryByRole("menu", { name: "Help & resources" }), null);
});

test("Help still exposes Feedback when the legacy capability field is disabled", async () => {
  renderRail({ feedbackEnabled: false });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await Promise.resolve();
  });

  const feedback = screen.getByRole("menuitem", { name: "Feedback" });
  act(() => {
    fireEvent.click(feedback);
  });
  assert.equal(screen.getByTestId("location-probe").textContent, "/s/botiverse/settings/feedback");
});

test("Documentation opens the canonical docs host", async () => {
  renderRail();
  const help = screen.getByRole("button", { name: "Help" });
  let opened: [string | URL | undefined, string | undefined, string | undefined] | null = null;
  window.open = ((url, target, features) => {
    opened = [url, target, features];
    return null;
  }) as typeof window.open;

  await act(async () => {
    fireEvent.click(help);
    await Promise.resolve();
  });
  act(() => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Raft Documentation" }));
  });
  assert.deepEqual(opened, ["https://docs.raft.build", "_blank", "noopener,noreferrer"]);
  assert.equal(screen.queryByRole("menu", { name: "Help & resources" }), null);
});

test("Join Community runs the shared join flow and opens the joined server", async () => {
  const joinCalls: Array<{ agreementId?: string | null; slug?: string }> = [];
  renderRail({
    joinCommunityServer: async (options = {}) => {
      joinCalls.push(options);
      return {
        id: "server-community",
        name: "Raft Community",
        slug: options.slug ?? "community",
        avatarUrl: null,
      } as never;
    },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Join Community" }));

  await waitFor(() => {
  assert.equal(joinCalls.length, 1);
  assert.equal(screen.getByTestId("location-probe").textContent, `/s/${joinCalls[0]?.slug}`);
  });
  assert.equal(joinCalls[0]?.slug, "community");
  assert.equal(screen.queryByRole("menu", { name: "Help & resources" }), null);
});

test("Chinese browser language sends Help community entry to the QR page without joining a server", async () => {
  const joinCalls: Array<{ agreementId?: string | null; slug?: string }> = [];
  renderRail({
    languages: ["zh-CN", "en-US"],
    joinCommunityServer: async (options = {}) => {
      joinCalls.push(options);
      return {
        id: "server-community",
        name: "Raft Community",
        slug: options.slug ?? "community",
        avatarUrl: null,
      } as never;
    },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Join Chinese Community" }));

  await waitFor(() => {
    assert.equal(screen.getByTestId("location-probe").textContent, "/community/chinese");
  });
  assert.deepEqual(joinCalls, []);
  assert.equal(screen.queryByRole("menu", { name: "Help & resources" }), null);
});
