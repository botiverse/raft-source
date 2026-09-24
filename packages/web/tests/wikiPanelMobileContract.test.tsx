import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import WikiPanel from "../src/components/wiki/WikiPanel";
import { TestIntlProvider } from "./helpers/intl";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const EXPECTED_SETUP_LABEL = "Setup";
const EXPECTED_REFRESH_ARIA = "Refresh Wiki now";
const EXPECTED_REFRESH_VISIBLE = "Refresh now";
const EXPECTED_REFRESH_REQUESTED_ARIA = "Wiki Agent refresh requested";
const EXPECTED_REFRESH_WORKING = "Agent working";
const EXPECTED_ALL_DOCUMENTS = "All documents";
const PAGE_TITLE = "Architecture";

const originalGet = api.get;
const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState({ current: null } as never);
  useChannelStore.setState({ openDM: async () => ({ id: "dm-1" }) } as never);
});

function seedWikiServer() {
  useServerStore.setState({
    current: {
      id: "server-1",
      slug: "wiki-server",
      name: "Wiki Server",
      role: "owner",
    },
  } as never);
  useChannelStore.setState({ openDM: async () => ({ id: "dm-1" }) } as never);
}

function renderWiki() {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <WikiPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function stubWiki(status: "setup_required" | "active", pages: Array<{ id: string; title: string }> = []) {
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      return {
        data: {
          space: {
            status,
            wikiAgentId: status === "active" ? "agent-wiki" : null,
            wikiAgentName: status === "active" ? "WikiAgent" : null,
            wikiChannelId: status === "active" ? "channel-wiki" : null,
            wikiChannelName: status === "active" ? "Wiki" : null,
          },
          lastJob: null,
        },
      };
    }
    if (url === "/wiki/directory") {
      return {
        data: {
          pages: pages.map((page) => ({
            id: page.id,
            artifactType: "page",
            title: page.title,
          })),
          index: { id: "index-1", artifactType: "index", title: "Index" },
          log: { id: "log-1", artifactType: "log", title: "Log" },
        },
      };
    }
    if (url.startsWith("/wiki/artifacts/")) {
      const id = url.slice("/wiki/artifacts/".length);
      const page = pages.find((entry) => entry.id === id);
      return {
        data: {
          id,
          artifactType: page ? "page" : "index",
          title: page?.title ?? "Index",
          markdown: "# doc",
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;
}

test("wiki header setup CTA hides on a wrapper, not on the Button itself", async () => {
  seedWikiServer();
  stubWiki("setup_required");
  renderWiki();

  const setup = await screen.findByRole("button", { name: EXPECTED_SETUP_LABEL });
  const wrapper = setup.parentElement;
  assert.equal(wrapper?.tagName, "SPAN");
  assert.match(wrapper?.className ?? "", /(^|\s)hidden(\s|$)/);
  assert.match(wrapper?.className ?? "", /(^|\s)sm:inline-flex(\s|$)/);
  assert.doesNotMatch(
    setup.className,
    /(^|\s)hidden(\s|$)/,
    "Button already uses inline-flex; hidden on the same node loses to stylesheet order",
  );
});

test("wiki refresh keeps a full accessible name when its visible label collapses", async () => {
  seedWikiServer();
  stubWiki("active");
  api.post = (async (url: string) => {
    assert.equal(url, "/wiki/refresh");
    return {
      data: {
        space: {
          status: "active",
          wikiAgentId: "agent-wiki",
          wikiAgentName: "WikiAgent",
          wikiChannelId: "channel-wiki",
          wikiChannelName: "Wiki",
          lastIngestReceiptId: "receipt-1",
        },
        job: { status: "running" },
        upToDate: false,
      },
    };
  }) as typeof api.post;
  renderWiki();

  const refresh = await screen.findByRole("button", { name: EXPECTED_REFRESH_ARIA });
  assert.equal(refresh.getAttribute("aria-label"), EXPECTED_REFRESH_ARIA);
  assert.equal(refresh.getAttribute("title"), EXPECTED_REFRESH_ARIA);
  const idleVisible = Array.from(refresh.querySelectorAll("span")).find((node) =>
    node.textContent === EXPECTED_REFRESH_VISIBLE,
  );
  assert.ok(idleVisible, "desktop refresh label must stay in the button");
  assert.match(idleVisible.className, /(^|\s)hidden(\s|$)/);
  assert.match(idleVisible.className, /(^|\s)sm:inline(\s|$)/);

  fireEvent.click(refresh);

  await waitFor(() => {
    assert.equal(refresh.getAttribute("aria-label"), EXPECTED_REFRESH_REQUESTED_ARIA);
    assert.equal(refresh.getAttribute("title"), EXPECTED_REFRESH_REQUESTED_ARIA);
  });
  const working = Array.from(refresh.querySelectorAll("span")).find((node) =>
    node.textContent === EXPECTED_REFRESH_WORKING,
  );
  assert.ok(working, "requested refresh must swap the visible label to Agent working");
  assert.match(working.className, /(^|\s)hidden(\s|$)/);
  assert.match(working.className, /(^|\s)sm:inline(\s|$)/);
});

test("wiki refresh completes only after the authoritative ingest receipt changes", async () => {
  seedWikiServer();
  let statusReads = 0;
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      statusReads += 1;
      return {
        data: {
          space: {
            status: "active" as const,
            wikiAgentId: "agent-wiki",
            wikiAgentName: "WikiAgent",
            wikiChannelId: "channel-wiki",
            wikiChannelName: "Wiki",
            lastIngestReceiptId: statusReads === 1 ? "receipt-before" : "receipt-after",
          },
          lastJob: { status: "running", progress: { percent: 91, label: "Publishing" } },
        },
      };
    }
    if (url === "/wiki/directory") return { data: { pages: [], index: null, log: null } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    assert.equal(url, "/wiki/refresh");
    return {
      data: {
        space: {
          status: "active",
          wikiAgentId: "agent-wiki",
          wikiAgentName: "WikiAgent",
          wikiChannelId: "channel-wiki",
          wikiChannelName: "Wiki",
          lastIngestReceiptId: "receipt-before",
        },
        job: { status: "running" },
        upToDate: false,
      },
    };
  }) as typeof api.post;
  renderWiki();

  fireEvent.click(await screen.findByRole("button", { name: EXPECTED_REFRESH_ARIA }));

  assert.ok(await screen.findByText("Wiki ingest completed."));
  assert.equal(statusReads, 2, "the wake receipt must be followed by an authoritative status read");
  assert.ok(screen.getByRole("button", { name: EXPECTED_REFRESH_ARIA }));
});

test("interrupted initialization mounts the server-owned retry action and progress", async () => {
  seedWikiServer();
  const posts: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      return {
        data: {
          space: {
            status: "initializing" as const,
            wikiAgentId: "agent-wiki",
            wikiAgentName: "WikiAgent",
            wikiChannelId: "channel-wiki",
            wikiChannelName: "Wiki",
            initialization: { resumable: true },
          },
          lastJob: {
            status: "failed",
            progress: { percent: 73, label: "Published sources" },
            error: "interrupted",
          },
        },
      };
    }
    if (url === "/wiki/directory") return { data: { pages: [], index: null, log: null } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    posts.push(url);
    return {
      data: {
        space: { status: "initializing", lastIngestReceiptId: "receipt-before" },
        job: { status: "running" },
        upToDate: false,
      },
    };
  }) as typeof api.post;
  renderWiki();

  const retry = await screen.findByRole("button", { name: "Retry initialization" });
  const progress = screen.getByRole("progressbar");
  assert.equal(progress.getAttribute("aria-valuenow"), "73");
  assert.ok(screen.getByText("Published sources"));
  fireEvent.click(retry);
  await waitFor(() => assert.deepEqual(posts, ["/wiki/refresh"]));
});

test("wiki document list is master-detail below md", async () => {
  seedWikiServer();
  stubWiki("active", [{ id: "page-1", title: PAGE_TITLE }]);
  renderWiki();

  const page = await screen.findByRole("button", { name: new RegExp(PAGE_TITLE) });
  const aside = document.querySelector("aside");
  const main = document.querySelector("main");
  assert.ok(aside);
  assert.ok(main);
  assert.match(aside.className, /(^|\s)flex(\s|$)/);
  assert.doesNotMatch(aside.className, /hidden md:flex/);
  assert.match(main.className, /hidden md:block/);
  assert.doesNotMatch(aside.className, /max-h-64/);

  fireEvent.click(page);

  await waitFor(() => {
    assert.match(aside.className, /hidden md:flex/);
    assert.match(main.className, /(^|\s)block(\s|$)/);
  });
  assert.ok(screen.getByRole("button", { name: EXPECTED_ALL_DOCUMENTS }));
});
