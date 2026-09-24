import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import {
  canUseBrowserBack,
  NavigationDepthTracker,
  isIdempotentNavigationCommit,
  nextNavigationDepth,
  nextNavigationStack,
  recordSynchronousMobileBackNavigation,
  resolveMobileBackAction,
  shouldConsumeSynchronousNavigation,
  useMobileBack,
} from "../src/hooks/useAppNavigate";
import {
  subscribeRightPanelThreadAnchor,
  syncRightPanelUrlFromStores,
} from "../src/components/layout/rightPanelUrlSync";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

afterEach(() => {
  cleanup();
  useServerStore.setState({ current: null });
  useThreadStore.getState().closeThread();
  window.history.replaceState(null, "", "/");
});

function makeServer(slug: string): Server {
  return {
    id: `server-${slug}`,
    name: slug,
    avatarUrl: null,
    slug,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-06-26T00:00:00.000Z",
  };
}

function setCurrentServer(slug: string) {
  useServerStore.setState({ current: makeServer(slug) });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function StringFallbackProbe({ fallback }: { fallback: string }) {
  const navigate = useNavigate();
  const mobileBack = useMobileBack(fallback);
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => navigate("/s/dev/search?q=term")}>open search</button>
      <button type="button" onClick={() => navigate("/s/dev/channel/general?msg=1")}>open channel</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function CrossServerProbe() {
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/s/bravo/channel/general");
  return (
    <>
      <LocationProbe />
      <button
        type="button"
        onClick={() => {
          setCurrentServer("bravo");
          navigate("/s/bravo/channel/general?thread=general:parent");
        }}
      >
        switch to bravo thread
      </button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function GlobalFallbackProbe() {
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/");
  return (
    <>
      <LocationProbe />
      <button
        type="button"
        onClick={() => {
          setCurrentServer("bravo");
          navigate("/s/bravo/channel/general?profile=human:1");
        }}
      >
        switch to bravo profile
      </button>
      <button type="button" onClick={mobileBack}>mobile back</button>
      <button type="button" onClick={() => navigate(-1)}>browser back</button>
    </>
  );
}

function CallbackFallbackProbe({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const mobileBack = useMobileBack(onClose);
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => navigate("/profile-panel")}>open profile panel</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function StatefulFallbackProbe() {
  const [fallback, setFallback] = useState("/fallback-one");
  const mobileBack = useMobileBack(fallback);
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => setFallback("/fallback-two")}>use second fallback</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function SinglePushProbe() {
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/");
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => navigate("/s/dev/channel/general")}>open channel once</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function ImmediateThreadBackProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  const mobileBack = useMobileBack("/s/dev/channel/general");
  const backedRef = useRef(false);

  useLayoutEffect(() => {
    if (!location.search.includes("thread=") || backedRef.current) return;
    backedRef.current = true;
    mobileBack();
  }, [location.search, mobileBack]);

  return (
    <>
      <LocationProbe />
      <button
        type="button"
        onClick={() => navigate(
          "/s/dev/channel/general?msg=parent&thread=general%3Aparent",
        )}
      >
        open and immediately back
      </button>
    </>
  );
}

function StoreOwnedImmediateThreadBackProbe() {
  const navigate = useNavigate();
  const closeThread = useThreadStore((state) => state.closeThread);
  const openParentMessageId = useThreadStore((state) => state.openParentMessageId);
  const mobileBack = useMobileBack("/s/dev/channel/general", closeThread);
  const openThread = () => {
    useThreadStore.setState({
      openParentChannelId: "general",
      openParentMessageId: "parent",
    });
    syncRightPanelUrlFromStores({
      fallback: {
        pathname: "/s/dev/channel/general",
        search: "?msg=parent",
      },
      navigate: (to, options) => {
        navigate(`${to.pathname}${to.search}`, { replace: options.replace });
      },
    });
  };

  return (
    <>
      <LocationProbe />
      <output data-testid="thread-state">{openParentMessageId ? "open" : "closed"}</output>
      <button type="button" onClick={openThread}>store opens thread</button>
      <button type="button" onClick={mobileBack}>store-owned mobile back</button>
      <button
        type="button"
        onClick={() => {
          openThread();
          mobileBack();
        }}
      >
        store opens thread and Back wins the Router commit race
      </button>
    </>
  );
}

function TaskOverlayFromThreadProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  const closeThread = useThreadStore((state) => state.closeThread);
  const openParentMessageId = useThreadStore((state) => state.openParentMessageId);
  const locationRef = useRef({ pathname: location.pathname, search: location.search });
  locationRef.current = { pathname: location.pathname, search: location.search };

  useLayoutEffect(() => subscribeRightPanelThreadAnchor(() => {
    syncRightPanelUrlFromStores({
      fallback: locationRef.current,
      navigate: (to, options) => {
        navigate(`${to.pathname}${to.search}`, { replace: options.replace });
        locationRef.current = to;
      },
    });
  }), [navigate]);

  const taskBack = useMobileBack(closeThread, closeThread);
  return (
    <>
      <LocationProbe />
      <output data-testid="task-overlay-state">{openParentMessageId ?? "closed"}</output>
      <button
        type="button"
        onClick={() => {
          useThreadStore.setState({
            openParentChannelId: "general",
            openParentMessageId: "task-parent",
            openIntent: "task",
          });
        }}
      >
        open task over thread
      </button>
      <button type="button" onClick={taskBack}>task sheet back</button>
    </>
  );
}

function SkippedCommitSameKeyProbe() {
  const mobileBack = useMobileBack("/s/dev/channel/general");
  const skipDestinationCommits = () => {
    const originState = window.history.state as Record<string, unknown> | null;
    const threadPath = "/s/dev/channel/general?msg=parent&thread=general%3Aparent";
    const originPath = "/s/dev/channel/general?msg=parent";
    window.history.pushState(
      { ...originState, idx: 1, key: "skipped-thread" },
      "",
      threadPath,
    );
    recordSynchronousMobileBackNavigation("PUSH", threadPath);
    window.history.replaceState(
      { ...originState, idx: 1, key: "skipped-close" },
      "",
      originPath,
    );
    recordSynchronousMobileBackNavigation("REPLACE", originPath);
    window.history.back();
  };

  return (
    <>
      <LocationProbe />
      <button type="button" onClick={skipDestinationCommits}>skip destination commits</button>
      <button type="button" onClick={mobileBack}>same-key parent back</button>
    </>
  );
}

function RerenderProbe() {
  const [renderCount, setRenderCount] = useState(0);
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/");
  return (
    <>
      <LocationProbe />
      <output data-testid="render-count">{renderCount}</output>
      <button type="button" onClick={() => navigate("/s/dev/channel/general")}>open channel once</button>
      <button type="button" onClick={() => setRenderCount((count) => count + 1)}>force rerender</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function ExplicitFallbackServerProbe() {
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/s/bravo/channel/general");
  return (
    <>
      <LocationProbe />
      <button
        type="button"
        onClick={() => {
          setCurrentServer("charlie");
          navigate("/s/charlie/channel/current");
        }}
      >
        switch to charlie
      </button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function PlainStringFallbackProbe() {
  const navigate = useNavigate();
  const mobileBack = useMobileBack("/members");
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => navigate("/profile-panel")}>open profile panel</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

function CallbackWithoutServerProbe({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const mobileBack = useMobileBack(onClose);
  return (
    <>
      <LocationProbe />
      <button type="button" onClick={() => navigate("/profile-panel")}>open profile panel</button>
      <button type="button" onClick={mobileBack}>mobile back</button>
    </>
  );
}

test("navigation helper tracks push replace and pop paths exactly", () => {
  let stack = nextNavigationStack([], "REPLACE", "/s/dev");
  assert.deepEqual(stack, ["/s/dev"]);

  stack = nextNavigationStack(stack, "PUSH", "/s/dev/search");
  assert.deepEqual(stack, ["/s/dev", "/s/dev/search"]);

  stack = nextNavigationStack(stack, "REPLACE", "/s/dev/search?q=hello");
  assert.deepEqual(stack, ["/s/dev", "/s/dev/search?q=hello"]);

  stack = nextNavigationStack(stack, "POP", "/s/dev");
  assert.deepEqual(stack, ["/s/dev"]);

  assert.deepEqual(
    nextNavigationStack(["/s/dev", "/s/dev/search", "/s/dev/channel/one"], "POP", "/s/dev/search"),
    ["/s/dev", "/s/dev/search"],
  );
  assert.deepEqual(
    nextNavigationStack(["/s/dev", "/s/dev/search", "/s/dev/channel/one"], "POP", "/s/dev/thread/one"),
    ["/s/dev", "/s/dev/search", "/s/dev/thread/one"],
  );
  assert.deepEqual(
    nextNavigationStack(["/s/dev/channel/one"], "POP", "/s/dev"),
    ["/s/dev"],
  );
  assert.deepEqual(
    nextNavigationStack(["/s/dev", "/s/dev/search"], "REPLACE", "/s/dev"),
    ["/s/dev", "/s/dev"],
  );
  assert.deepEqual(
    nextNavigationStack(["/s/dev", "/s/dev/search", "/s/dev/channel/one"], "REPLACE", "/s/dev/thread/one"),
    ["/s/dev", "/s/dev/search", "/s/dev/thread/one"],
  );
});

test("task sheet opened over a thread owns a PUSH and Back restores the exact origin URL", async () => {
  setCurrentServer("dev");
  window.history.replaceState(
    { ...(window.history.state as object), idx: 0 },
    "",
    "/s/dev/channel/general?msg=origin-reply&thread=general%3Aorigin-parent",
  );
  render(
    <BrowserRouter>
      <NavigationDepthTracker />
      <TaskOverlayFromThreadProbe />
    </BrowserRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "open task over thread" }));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=origin-reply&thread=general%3Atask-parent&task=1",
    );
  });

  fireEvent.click(screen.getByRole("button", { name: "task sheet back" }));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=origin-reply&thread=general%3Aorigin-parent",
    );
    assert.equal(screen.getByTestId("task-overlay-state").textContent, "closed");
  });
});

test("same-path POP cannot consume the preceding entry's synchronous REPLACE", () => {
  const pending = {
    navigationType: "REPLACE" as const,
    historyIndex: 1,
    path: "/s/dev/channel/general?msg=parent",
  };

  assert.equal(
    shouldConsumeSynchronousNavigation(pending, {
      navigationType: "POP",
      historyIndex: 0,
      path: pending.path,
    }),
    false,
  );
  assert.equal(
    shouldConsumeSynchronousNavigation(pending, {
      navigationType: "REPLACE",
      historyIndex: 1,
      path: pending.path,
    }),
    true,
  );
});

test("same Router key cannot hide a browser entry-index POP", () => {
  assert.equal(
    isIdempotentNavigationCommit("origin-key", "origin-key", 1, 0),
    false,
    "returning to the original key after a skipped destination commit is a real POP",
  );
  assert.equal(
    isIdempotentNavigationCommit("origin-key", "origin-key", 0, 0),
    true,
    "a same-key rerender on the same entry remains idempotent",
  );
  assert.equal(
    isIdempotentNavigationCommit("origin-key", "destination-key", 0, 1),
    false,
  );
});

test("mobile back action distinguishes depth and same-server stack history", () => {
  assert.equal(nextNavigationDepth(0, "PUSH"), 1);
  assert.equal(nextNavigationDepth(1, "POP"), 0);
  assert.equal(nextNavigationDepth(0, "POP"), 0);
  assert.equal(nextNavigationDepth(5, "REPLACE"), 5);

  assert.deepEqual(resolveMobileBackAction(0, "/s/dev"), { kind: "fallback", path: "/s/dev" });
  assert.deepEqual(resolveMobileBackAction(1, "/s/dev"), { kind: "back" });
  assert.deepEqual(
    resolveMobileBackAction(["/s/dev", "/s/dev/search?q=hello", "/s/dev/channel/abc"], "/s/dev"),
    { kind: "back" },
  );
  assert.deepEqual(
    resolveMobileBackAction(["/s/alpha", "/s/bravo/channel/abc?thread=abc:p1"], "/s/bravo/channel/abc"),
    { kind: "fallback", path: "/s/bravo/channel/abc" },
  );
  assert.deepEqual(
    resolveMobileBackAction(["/s/alpha", "/s/bravo/channel/abc"], "/", "/s/bravo/channel/abc"),
    { kind: "fallback", path: "/" },
  );
  assert.deepEqual(
    resolveMobileBackAction(
      ["/s/alpha/start", "/s/bravo/search", "/s/alpha/channel/current"],
      "/s/alpha",
    ),
    { kind: "fallback", path: "/s/alpha" },
  );
});

test("server scope parser only permits browser back inside the same server", () => {
  assert.equal(canUseBrowserBack("/s/dev/search?q=hello", "/s/dev/channel/abc"), true);
  assert.equal(canUseBrowserBack("/s/alpha/channel/a", "/s/bravo/channel/b"), false);
  assert.equal(canUseBrowserBack("/s/devotion/channel/a", "/s/dev/channel/b"), false);
  assert.equal(canUseBrowserBack("/outside/s/dev/channel/a", "/s/dev/channel/b"), false);
  assert.equal(canUseBrowserBack("/s/dev/channel/a", "/"), true);
  assert.equal(canUseBrowserBack("/welcome", "/"), true);
});

test("mobile back uses browser history for same-server in-app paths", async () => {
  setCurrentServer("dev");
  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <NavigationDepthTracker />
      <StringFallbackProbe fallback="/s/dev" />
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("location").textContent, "/s/dev");
  fireEvent.click(screen.getByText("open search"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev/search?q=term");
  });
  fireEvent.click(screen.getByText("open channel"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev/channel/general?msg=1");
  });

  fireEvent.click(screen.getByText("mobile back"));

  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev/search?q=term");
  });
});

test("mobile back falls back instead of popping into a previous server", async () => {
  setCurrentServer("alpha");
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <CrossServerProbe />
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("location").textContent, "/s/alpha/channel/random");
  fireEvent.click(screen.getByText("switch to bravo thread"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/bravo/channel/general?thread=general:parent",
    );
  });

  fireEvent.click(screen.getByText("mobile back"));

  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/bravo/channel/general");
  });
});

test("mobile back uses current server scope even when fallback goes to root", async () => {
  setCurrentServer("alpha");
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <GlobalFallbackProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("switch to bravo profile"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/bravo/channel/general?profile=human:1",
    );
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/");
  });

  fireEvent.click(screen.getByText("browser back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/alpha/channel/random");
  });
});

test("callback fallback inherits current server when the URL has no server segment", async () => {
  const closeCalls: string[] = [];
  setCurrentServer("bravo");
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <CallbackFallbackProbe onClose={() => closeCalls.push("closed")} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open profile panel"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/profile-panel");
  });

  fireEvent.click(screen.getByText("mobile back"));

  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/profile-panel");
    assert.deepEqual(closeCalls, ["closed"]);
  });
});

test("mobile back callback updates when the fallback prop changes", async () => {
  render(
    <MemoryRouter initialEntries={["/entry"]}>
      <NavigationDepthTracker />
      <StatefulFallbackProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("use second fallback"));
  fireEvent.click(screen.getByText("mobile back"));

  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/fallback-two");
  });
});

test("initial stack entry is preserved for the first same-server push", async () => {
  setCurrentServer("dev");
  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <NavigationDepthTracker />
      <SinglePushProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open channel once"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev/channel/general");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev");
  });
});

test("thread Back sees the PUSH before the destination can handle input", async () => {
  setCurrentServer("dev");
  render(
    <MemoryRouter initialEntries={["/s/dev/channel/general?msg=parent"]}>
      <NavigationDepthTracker />
      <ImmediateThreadBackProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open and immediately back"));

  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=parent",
    );
  });
});

test("store-owned thread Back sees its synchronous URL PUSH before Router commits", async () => {
  setCurrentServer("dev");
  window.history.replaceState(null, "", "/s/dev/channel/general?msg=parent");
  render(
    <BrowserRouter>
      <NavigationDepthTracker />
      <StoreOwnedImmediateThreadBackProbe />
    </BrowserRouter>,
  );

  fireEvent.click(screen.getByText("store opens thread and Back wins the Router commit race"));

  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=parent",
    );
    assert.equal(screen.getByTestId("thread-state").textContent, "closed");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(screen.getByTestId("thread-state").textContent, "closed");

  fireEvent.click(screen.getByText("store-owned mobile back"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general",
    );
    assert.equal(
      (window.history.state as { idx?: unknown } | null)?.idx,
      0,
      "the parent Back must use the semantic fallback at the origin entry, not pop again",
    );
  });
});

test("same-key POP after skipped PUSH/REPLACE commits clears false module depth", async () => {
  setCurrentServer("dev");
  window.history.replaceState(null, "", "/s/dev/channel/general?msg=parent");
  render(
    <BrowserRouter>
      <NavigationDepthTracker />
      <SkippedCommitSameKeyProbe />
    </BrowserRouter>,
  );

  fireEvent.click(screen.getByText("skip destination commits"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=parent",
    );
    assert.equal((window.history.state as { idx?: unknown } | null)?.idx, 0);
  });

  fireEvent.click(screen.getByText("same-key parent back"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general",
    );
    assert.equal((window.history.state as { idx?: unknown } | null)?.idx, 0);
  });
});

test("Router commit consumes a synchronous store-owned PUSH without duplicating history", async () => {
  setCurrentServer("dev");
  window.history.replaceState(null, "", "/s/dev/channel/general?msg=parent");
  render(
    <BrowserRouter>
      <NavigationDepthTracker />
      <StoreOwnedImmediateThreadBackProbe />
    </BrowserRouter>,
  );

  fireEvent.click(screen.getByText("store opens thread"));
  await waitFor(() => {
    assert.match(
      screen.getByTestId("location").textContent ?? "",
      /\?msg=parent&thread=general%3Aparent$/,
    );
  });

  fireEvent.click(screen.getByText("store-owned mobile back"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general?msg=parent",
    );
    assert.equal(screen.getByTestId("thread-state").textContent, "closed");
  });

  fireEvent.click(screen.getByText("store-owned mobile back"));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/dev/channel/general",
    );
  });
});

test("same-key rerenders do not create duplicate navigation stack entries", async () => {
  setCurrentServer("dev");
  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <NavigationDepthTracker />
      <RerenderProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open channel once"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev/channel/general");
  });
  fireEvent.click(screen.getByText("force rerender"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("render-count").textContent, "1");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/dev");
  });
  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/");
  });
});

test("explicit server fallback scopes against its own server", async () => {
  setCurrentServer("alpha");
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <ExplicitFallbackServerProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("switch to charlie"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/charlie/channel/current");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/bravo/channel/general");
  });
});

test("explicit server fallback wins over a same-server previous entry", async () => {
  setCurrentServer("charlie");
  render(
    <MemoryRouter initialEntries={["/s/charlie/channel/previous"]}>
      <NavigationDepthTracker />
      <ExplicitFallbackServerProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("switch to charlie"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/charlie/channel/current");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/bravo/channel/general");
  });
});

test("plain string fallback keeps browser back available outside server URLs", async () => {
  setCurrentServer("bravo");
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <PlainStringFallbackProbe />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open profile panel"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/profile-panel");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/alpha/channel/random");
  });
});

test("callback fallback without server context still permits ordinary browser back", async () => {
  const closeCalls: string[] = [];
  useServerStore.setState({ current: null });
  render(
    <MemoryRouter initialEntries={["/s/alpha/channel/random"]}>
      <NavigationDepthTracker />
      <CallbackWithoutServerProbe onClose={() => closeCalls.push("closed")} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText("open profile panel"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/profile-panel");
  });

  fireEvent.click(screen.getByText("mobile back"));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/alpha/channel/random");
    assert.deepEqual(closeCalls, []);
  });
});
