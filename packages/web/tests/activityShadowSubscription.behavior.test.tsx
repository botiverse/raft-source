/**
 * task #364 S1 — teeth for the `useSyncExternalStore` binding onto the Activity
 * shadow.
 *
 * At the S1 checkpoint (@赵梓淇), this was subscription-only and the visible
 * window stayed legacy. S2 has separate receiver teeth; this file continues to
 * own only the primitive subscription and production notification path.
 *
 * THE LOAD-BEARING TOOTH IS THE REAL-PATH ONE. An earlier round of this file
 * asserted only "manual notify + unchanged snapshot does not re-render", which
 * @赵梓淇 broke by deleting the single `notifyShadowListeners()` call after
 * `drain()` — all teeth stayed green. That version proved the hook could work,
 * not that the production bridge exists. So the real-path tooth below drives
 * the actual bootstrap and requires that a mounted PRODUCTION consumer observes
 * the applied watermark, and that the notification happens AFTER the core has
 * settled.
 *
 * VERIFIED REVERSE CUTS:
 *  - delete `publishActivityShadowVersion()` after `drain()` -> isolation RED
 *
 * DECLARED GAP, do not read these teeth as covering it: moving that call to
 * BEFORE `await drain()` does NOT go red. In this fixture the snapshot is
 * `complete: true` with no pending requests, so `drain()` is a no-op and the
 * applied watermark is identical either side of it — nothing distinguishes the
 * two orderings. Pinning "notify happens AFTER the core settled" needs a
 * fixture where drain itself advances the watermark (an incomplete snapshot
 * whose difference fetch moves it on). Stated rather than implied, because a
 * reader would otherwise assume the ordering is guarded.
 *  - `getActivityShadowVersion` returns `{ v: ... }`   -> stability tooth RED
 *    (on its render count, through React's external-store re-render path)
 *  - make the notifier catch only synchronous throws   -> async tooth RED
 */
import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
import { TestIntlProvider } from "./helpers/intl";
import { createRenderCounter } from "./helpers/renderCount";
import { useAuthStore } from "../src/store/authStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import {
  activityWindowAuthority,
  getActivityShadowListenerCountForTests,
  getActivityShadowObservationForTests,
  getActivityShadowVersion,
  notifyActivityShadowForTests,
  observeActivityBootstrap,
  resetActivityRuntimeForTests,
  setActivityGateForTests,
  subscribeActivityShadow,
} from "../src/store/activityPanel/runtime";
import { useActivityShadowVersion } from "../src/store/activityPanel/useActivityShadow";

// These share global zustand stores; serialize them.
type TestFn = (t: unknown) => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn as never);

const SERVER_ID = "server-1";
const PRINCIPAL_ID = "user-1";

/**
 * 2^53 + 1 — NOT representable as a double.
 *
 * The watermark is UInt64 in the contract, so if anything on the path routes it
 * through a number this value comes back as ...992 and the assertion fails. A
 * small seq would pass whether or not the path is lossless.
 */
const BIG_WATERMARK = "9007199254740993";

const originalGet = api.get.bind(api);
const originalAuth = useAuthStore.getState();
const originalServer = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  resetActivityRuntimeForTests();
  useAuthStore.setState(originalAuth, true);
  useServerStore.setState(originalServer, true);
});

function activitySnapshotBody(watermark: string, requestId: string) {
  return {
    type: "snapshot",
    // The consumer correlates on this: a body that does not echo the id the
    // runtime issued is dropped as unsolicited, and the tooth would see null
    // for a reason that has nothing to do with the property under test.
    requestId,
    scope: {
      serverId: SERVER_ID,
      principalId: PRINCIPAL_ID,
      filter: "all",
      windowId: "main",
    },
    epoch: "1",
    watermark,
    activityVersion: "7",
    window: {
      rows: [],
      tombstones: [],
      nextCursor: null,
      hasMore: false,
      complete: true,
      totalCount: 0,
      totalUnreadCount: 0,
    },
  };
}

/** ThreadsInbox branches on matchMedia; jsdom does not provide it. */
function setDesktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function Probe() {
  // Renders a DERIVED primitive, never the snapshot itself: rendering the value
  // directly would make an object snapshot fail React's "Objects are not valid
  // as a React child" check, which looks like the tooth working while leaving
  // the actual re-render loop unguarded (a component rendering `version.v`
  // would loop forever and this would stay green).
  const version = useActivityShadowVersion();
  return <span data-testid="version">{typeof version === "string" ? version : "none"}</span>;
}

test("gate off: mounting the hook registers no listener at all", () => {
  setActivityGateForTests("off");

  render(<Probe />);

  assert.equal(
    getActivityShadowListenerCountForTests(),
    0,
    "with the gate off the subscription must have zero residency — off has to mean off, not 'subscribed but idle'",
  );
});

test("gate shadow: the hook subscribes on mount and releases on unmount", () => {
  setActivityGateForTests("shadow");

  const view = render(<Probe />);
  assert.equal(getActivityShadowListenerCountForTests(), 1);

  view.unmount();
  assert.equal(
    getActivityShadowListenerCountForTests(),
    0,
    "unmounting must release the listener — a leaked subscription outlives the component that wanted it",
  );
});

test("an unchanged snapshot does not re-render, however many notifications arrive", () => {
  setActivityGateForTests("shadow");
  const rc = createRenderCounter();

  render(
    <rc.Count id="probe">
      <Probe />
    </rc.Count>,
  );
  const afterMount = rc.get("probe");
  assert.ok(afterMount > 0);

  act(() => {
    notifyActivityShadowForTests();
    notifyActivityShadowForTests();
    notifyActivityShadowForTests();
  });

  assert.equal(
    rc.get("probe"),
    afterMount,
    "an unchanged watermark must not produce a single extra commit — a non-primitive snapshot would re-render on every notification",
  );
});

test("a listener that rejects asynchronously cannot break notification or the process", async () => {
  setActivityGateForTests("shadow");
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const seen: string[] = [];
  try {
    // `() => void` ACCEPTS an async function. A notifier that guards only the
    // synchronous half lets this rejection escape to the process.
    const stopBad = subscribeActivityShadow((async () => {
      throw new Error("async subscriber exploded");
    }) as unknown as () => void);
    const stopGood = subscribeActivityShadow(() => {
      seen.push("neighbour");
    });

    notifyActivityShadowForTests();
    // Two macrotask turns: an escaped rejection surfaces on a later tick, so
    // asserting immediately would pass even when the guard is missing.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      seen,
      ["neighbour"],
      "a failing subscriber must not stop the ones after it",
    );
    assert.deepEqual(
      escaped,
      [],
      "an async rejection from a subscriber must be swallowed — otherwise an observability sink kills the process it observes",
    );

    stopBad();
    stopGood();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the diagnostic windowAuthority never promotes an absent scope", () => {
  for (const gate of ["off", "shadow", "on"] as const) {
    resetActivityRuntimeForTests();
    setActivityGateForTests(gate);
    assert.equal(
      activityWindowAuthority("any-scope").authority,
      "legacy",
      `gate=${gate}: an absent scope cannot be promoted by the diagnostic gate wrapper`,
    );
  }
});

test("REAL PATH: the mounted production Activity panel subscribes and observes the applied watermark", async () => {
  setActivityGateForTests("shadow");
  setDesktopViewport();
  useAuthStore.setState({ ...originalAuth, user: { id: PRINCIPAL_ID } } as never, true);
  useServerStore.setState(
    { ...originalServer, current: { id: SERVER_ID, name: "S", slug: "s" } } as never,
    true,
  );

  // Hold the snapshot response open so "before settle" is a real, observable
  // window rather than a hopeful assertion between two synchronous statements.
  let releaseSnapshot: (() => void) | null = null;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });

  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      await snapshotGate;
      return { data: activitySnapshotBody(BIG_WATERMARK, config?.params?.requestId ?? "") };
    }
    if (url === "/channels/inbox") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    // A legal empty payload, not `{}`: an undefined list made the panel throw
    // `undefined.map` twice inside an otherwise green test, and an unexpected
    // exception hiding inside a pass is exactly what these teeth exist to stop.
    if (url === "/channels/inbox/unfollowed") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    return { data: { items: [], totalCount: 0, hasMore: false } };
  }) as typeof api.get;

  // The REAL production consumer, not a bespoke probe.
  render(
    <MemoryRouter initialEntries={["/s/s/activity"]}>
      <TestIntlProvider>
        <ThreadsInbox />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.equal(
    getActivityShadowListenerCountForTests(),
    1,
    "the production panel must actually subscribe — a hook only tests mount is the 'no production caller' defect this directory already shipped twice",
  );

  // Drive the real bootstrap through the real store action.
  //
  // NOT wrapped in act() here: awaiting one act() inside another leaves React's
  // act environment inconsistent for whatever runs next, which is how this file
  // ended up with an order-dependent tooth. The single act() below covers the
  // window where state actually settles.
  const load = useInboxStore.getState().loadInbox();

  assert.equal(
    getActivityShadowObservationForTests(),
    null,
    "nothing may be observed while the snapshot is still in flight — an observation before the core applied it would be a watermark the core never settled on",
  );

  await act(async () => {
    releaseSnapshot?.();
    await load;
  });

  await waitFor(() => {
    assert.equal(
      getActivityShadowObservationForTests(),
      BIG_WATERMARK,
      "after the bootstrap settles the mounted panel must observe the applied watermark, losslessly and as a canonical decimal string",
    );
  });
});

test("the notification after drain() is the ONLY way a subscriber learns — nothing else re-renders it", async () => {
  // Self-initialise. This tooth previously passed in first position and failed
  // in last, which makes order a hidden input — an order-dependent tooth is a
  // false-green waiting to happen, so it establishes its own preconditions
  // instead of inheriting whatever the previous test left behind.
  cleanup();
  resetActivityRuntimeForTests();
  setActivityGateForTests("shadow");

  // Deliberately NOT ThreadsInbox. The panel re-renders whenever the inbox
  // store changes, so it would re-read getSnapshot through the ordinary render
  // path and observe the new watermark even with the notification bridge
  // deleted — which is how the previous round of this file passed while proving
  // nothing. This probe has no other reason to re-render, so the subscription is
  // the only channel left, and deleting the notify call must strand it.
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return { data: activitySnapshotBody(BIG_WATERMARK, config?.params?.requestId ?? "") };
    }
    return { data: {} };
  }) as typeof api.get;

  render(<Probe />);
  assert.equal(getActivityShadowListenerCountForTests(), 1);
  assert.equal(getActivityShadowObservationForTests(), null);

  await act(async () => {
    await observeActivityBootstrap();
  });

  assert.equal(
    getActivityShadowVersion(),
    BIG_WATERMARK,
    "precondition: the core must have applied the watermark, or this tooth would be measuring a failed bootstrap instead of the bridge",
  );
  await waitFor(() => {
    assert.equal(
      getActivityShadowObservationForTests(),
      BIG_WATERMARK,
      "with no other re-render source, the subscriber can only have learned this through the runtime publication after drain() — delete that call and this must go red",
    );
  });
});

test("an UNCORRELATED response must not move the external-store selector either", async () => {
  cleanup();
  resetActivityRuntimeForTests();
  setActivityGateForTests("shadow");

  // Scope 1 is accepted normally and becomes the observed truth.
  let phase: "first" | "wrongId" = "first";
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url !== "/channels/activity/snapshot") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    const issued = config?.params?.requestId ?? "";
    if (phase === "first") {
      return { data: activitySnapshotBody("5", issued) };
    }
    // Well-formed, different scope, but echoing an id we never issued: the
    // consumer must refuse it. Nothing about it may reach the selector.
    return {
      data: {
        ...activitySnapshotBody(BIG_WATERMARK, "not-a-request-we-issued"),
        scope: { serverId: "server-2", principalId: PRINCIPAL_ID, filter: "all", windowId: "main" },
      },
    };
  }) as typeof api.get;

  render(<Probe />);
  await act(async () => {
    await observeActivityBootstrap();
  });
  assert.equal(getActivityShadowVersion(), "5", "precondition: scope 1 must be the accepted truth");

  phase = "wrongId";
  await act(async () => {
    await observeActivityBootstrap();
  });

  assert.equal(
    getActivityShadowVersion(),
    "5",
    "a response the consumer refuses to fold must not move the active scope — the core stays right while the selector flips to null, which a subscriber reads as 'the data went away'",
  );
  await waitFor(() => {
    assert.equal(getActivityShadowObservationForTests(), "5");
  });
});
