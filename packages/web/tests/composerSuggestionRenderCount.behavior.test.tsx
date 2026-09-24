/**
 * Render-count guard for useRankedComposerSuggestions (铁根 render-perf #4446).
 *
 * Below the worker threshold (the common MessageInput / CreateChannel path;
 * jsdom has no Worker so this is always the path here) the effect resets the
 * worker state on every query change. Calling setWorkerState with a fresh
 * `{ pendingRequestId: 0, result: null }` object each time re-rendered the
 * consumer once per keystroke for nothing. The reset is now guarded (it only
 * fires setState when the state is not already the cleared value), because a
 * same-value setState from an effect still costs a render commit.
 *
 * We assert relative to a plain control component driven by the same query
 * prop: the composer probe must re-render NO MORE than the control on a
 * sub-threshold query change. If the no-op reset re-render came back, the probe
 * would commit one extra time. This is robust to React's absolute
 * mount/StrictMode commit baseline.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { createRenderCounter } from "./helpers/renderCount";
import { useRankedComposerSuggestions } from "../src/hooks/useRankedComposerSuggestions";
import type { ComposerSuggestionSearchEntry } from "../src/utils/composerSuggestionSearch";

test.afterEach(cleanup);

function entries(n: number): ComposerSuggestionSearchEntry<string>[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    suggestion: `name-${i}`,
    fields: [{ raw: `name-${i}`, priority: 1 }],
  }));
}

function Control({ query }: { query: string }) {
  return <div data-testid="control">{query.length}</div>;
}

function Probe({
  query,
  data,
  threshold = 200,
}: {
  query: string;
  data: ComposerSuggestionSearchEntry<string>[];
  threshold?: number;
}) {
  const results = useRankedComposerSuggestions(query, data, { workerThreshold: threshold });
  return <div data-testid="probe">{results.length}</div>;
}

function Harness({ rc, data }: { rc: ReturnType<typeof createRenderCounter>; data: ComposerSuggestionSearchEntry<string>[] }) {
  const [query, setQuery] = useState("na");
  return (
    <>
      <rc.Count id="probe">
        <Probe query={query} data={data} />
      </rc.Count>
      <rc.Count id="control">
        <Control query={query} />
      </rc.Count>
      <button data-testid="type" onClick={() => setQuery((q) => `${q}m`)}>
        type
      </button>
    </>
  );
}

test("sub-threshold composer suggestions add no no-op re-render on a query change", () => {
  const data = entries(3); // < workerThreshold (200) → sync path, worker never used
  const rc = createRenderCounter();

  act(() => {
    render(<Harness rc={rc} data={data} />);
  });

  // Mount control-equivalence: the guarded reset must add no commit on the
  // sub-threshold mount (state starts cleared, so setState is skipped).
  assert.equal(
    rc.get("probe"),
    rc.get("control"),
    "mount: guarded reset adds no commit — composer probe mounts with no more renders than a plain control",
  );

  rc.reset();
  act(() => {
    fireEvent.click(screen.getByTestId("type"));
  });
  assert.equal(
    rc.get("probe"),
    rc.get("control"),
    "composer probe must re-render no more than a plain control on a sub-threshold query change (identity-preserving reset = no no-op commit)",
  );

  rc.reset();
  act(() => {
    fireEvent.click(screen.getByTestId("type"));
  });
  assert.equal(
    rc.get("probe"),
    rc.get("control"),
    "a subsequent sub-threshold query change also adds no extra composer commit",
  );
});

// Minimal Worker stub so the hook takes the worker branch without a real Worker
// runtime (jsdom has none). It never posts a response, so the worker state stays
// "pending" until entries drop below threshold and the effect resets it — which
// is exactly the worker→sync→sync sequence we want to pin.
class FakeWorker {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  terminate() {}
}

// Control that re-renders on the same prop drivers as the worker Probe (query
// AND entries), so any extra Probe render is attributable to worker state, not
// to a prop change the control didn't see.
function WorkerControl({ query, dataLen }: { query: string; dataLen: number }) {
  return <div data-testid="control">{query.length + dataLen}</div>;
}

function WorkerHarness({ rc }: { rc: ReturnType<typeof createRenderCounter> }) {
  // step 0: worker active (query non-empty, entries ≥ threshold)
  // step 1: first sync — entries drop below threshold → one legal reset commit
  // step 2: second sync — entries change again → guard must add no commit
  const [step, setStep] = useState(0);
  const data = step === 0 ? entries(3) : step === 1 ? entries(1) : entries(0);
  const query = "na";
  return (
    <>
      <rc.Count id="probe">
        <Probe query={query} data={data} threshold={2} />
      </rc.Count>
      <rc.Count id="control">
        <WorkerControl query={query} dataLen={data.length} />
      </rc.Count>
      <button data-testid="advance" onClick={() => setStep((s) => s + 1)}>
        advance
      </button>
    </>
  );
}

test("worker→sync→sync: first sync resets once, the second adds no no-op commit", () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  holder.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const rc = createRenderCounter();
    act(() => {
      render(<WorkerHarness rc={rc} />);
    });
    // step 0: worker branch ran (setWorkerState pending → reset ref cleared)

    rc.reset();
    act(() => {
      fireEvent.click(screen.getByTestId("advance")); // → step 1: first sync
    });
    // The worker→sync transition must fire EXACTLY one reset commit on top of
    // the prop-driven render. Exact `control + 1` (not `<= control + 1`) pins
    // the worker-branch `workerStateIsResetRef.current = false`: if that ref
    // clear is dropped, the first sync skips the reset (state drifts from the
    // ref), probe would equal control, and a `<=` bound would false-green it.
    assert.equal(
      rc.get("probe"),
      rc.get("control") + 1,
      `first sync (worker→sync) must fire exactly one reset commit: probe=${rc.get("probe")} control=${rc.get("control")}`,
    );

    rc.reset();
    act(() => {
      fireEvent.click(screen.getByTestId("advance")); // → step 2: second sync
    });
    assert.equal(
      rc.get("probe"),
      rc.get("control"),
      "second sync (already reset) adds no no-op commit — guard holds on the worker→sync path",
    );
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});

interface ControllableWorkerRequest {
  requestId: number;
  query: string;
  entries?: unknown[];
}

class ControllableWorker {
  static requests: Array<{ worker: ControllableWorker; payload: ControllableWorkerRequest }> = [];

  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(payload: ControllableWorkerRequest) {
    ControllableWorker.requests.push({ worker: this, payload });
  }

  respond(indexes: number[]) {
    const latestRequest = ControllableWorker.requests.findLast((request) => request.worker === this)?.payload;
    if (!latestRequest) throw new Error("No worker request to respond to");
    const event = {
      data: { type: "ranked", requestId: latestRequest.requestId, indexes },
    } as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }

  terminate() {}
}

const workerSearchEntriesA: ComposerSuggestionSearchEntry<string>[] = [
  { index: 0, suggestion: "Cody", fields: [{ raw: "Cody", priority: 0 }] },
  { index: 1, suggestion: "Alice", fields: [{ raw: "Alice", priority: 0 }] },
  { index: 2, suggestion: "Bob", fields: [{ raw: "Bob", priority: 0 }] },
];

const workerSearchEntriesB: ComposerSuggestionSearchEntry<string>[] = [
  { index: 0, suggestion: "Aaron", fields: [{ raw: "Aaron", priority: 0 }] },
  { index: 1, suggestion: "Alice", fields: [{ raw: "Alice", priority: 0 }] },
  { index: 2, suggestion: "Cody", fields: [{ raw: "Cody", priority: 0 }] },
  { index: 3, suggestion: "Bob", fields: [{ raw: "Bob", priority: 0 }] },
];

const workerSearchEntriesC: ComposerSuggestionSearchEntry<string>[] = [
  { index: 0, suggestion: "Aaron", fields: [{ raw: "Aaron", priority: 0 }] },
  { index: 1, suggestion: "Alice", fields: [{ raw: "Alice", priority: 0 }] },
  { index: 2, suggestion: "Bob", fields: [{ raw: "Bob", priority: 0 }] },
];

function WorkerRefreshHarness() {
  const [refreshStep, setRefreshStep] = useState(0);
  const data = refreshStep === 0 ? workerSearchEntriesA : refreshStep === 1 ? workerSearchEntriesB : workerSearchEntriesC;
  const results = useRankedComposerSuggestions("co", data, {
    workerThreshold: 2,
  });

  return (
    <>
      <div data-testid="results">{results.join(",") || "empty"}</div>
      <button data-testid="refresh-entries" onClick={() => setRefreshStep((step) => step + 1)}>
        refresh entries
      </button>
    </>
  );
}

test("worker-backed suggestions keep current snapshot while same-query entries add, remove, and reorder", async () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  ControllableWorker.requests = [];
  holder.Worker = ControllableWorker as unknown as typeof Worker;
  try {
    act(() => {
      render(<WorkerRefreshHarness />);
    });

    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 1);
    });
    act(() => {
      ControllableWorker.requests[0]?.worker.respond([0]);
    });
    assert.equal(screen.getByTestId("results").textContent, "Cody");

    act(() => {
      fireEvent.click(screen.getByTestId("refresh-entries"));
    });
    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 2);
    });
    assert.equal(
      screen.getByTestId("results").textContent,
      "Cody",
      "Search-side entity suggestions must keep the old suggestion snapshot while refreshed entries insert and reorder indexes",
    );

    act(() => {
      ControllableWorker.requests[1]?.worker.respond([2]);
    });
    assert.equal(screen.getByTestId("results").textContent, "Cody");

    act(() => {
      fireEvent.click(screen.getByTestId("refresh-entries"));
    });
    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 3);
    });
    assert.equal(
      screen.getByTestId("results").textContent,
      "Cody",
      "Search-side entity suggestions must keep the prior suggestion snapshot while refreshed entries remove the old result before rerank returns",
    );

    act(() => {
      ControllableWorker.requests[2]?.worker.respond([]);
    });
    assert.equal(screen.getByTestId("results").textContent, "empty");
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});

function WorkerTypingHarness({ data }: { data: ComposerSuggestionSearchEntry<string>[] }) {
  const [query, setQuery] = useState("co");
  const results = useRankedComposerSuggestions(query, data, { workerThreshold: 2 });
  return (
    <>
      <div data-testid="results">{results.join(",") || "empty"}</div>
      <div data-testid="query">{query}</div>
      <button data-testid="type-a" onClick={() => setQuery("al")}>
        type al
      </button>
      <button data-testid="type-b" onClick={() => setQuery((q) => `${q}i`)}>
        append i
      </button>
    </>
  );
}

test("worker-backed suggestions keep the previous snapshot across a query change until the worker answers (task #266)", async () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  ControllableWorker.requests = [];
  holder.Worker = ControllableWorker as unknown as typeof Worker;
  try {
    act(() => {
      render(<WorkerTypingHarness data={workerSearchEntriesA} />);
    });

    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 1);
    });
    act(() => {
      ControllableWorker.requests[0]?.worker.respond([0]);
    });
    assert.equal(screen.getByTestId("results").textContent, "Cody");

    // Keystroke: the popover must NOT collapse while the next rank is pending
    // (stale-while-revalidate). Before task #266 the effect cleared the result
    // to null here and the popover unmounted → the autocomplete flicker.
    act(() => {
      fireEvent.click(screen.getByTestId("type-a"));
    });
    assert.equal(screen.getByTestId("query").textContent, "al");
    assert.equal(
      screen.getByTestId("results").textContent,
      "Cody",
      "query change must keep the previous suggestion snapshot on screen until the worker answers",
    );

    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 2);
    });
    assert.equal(ControllableWorker.requests[1]?.payload.query, "al");
    // Still the old snapshot while request 2 is unanswered.
    assert.equal(screen.getByTestId("results").textContent, "Cody");

    act(() => {
      ControllableWorker.requests[1]?.worker.respond([1]);
    });
    assert.equal(screen.getByTestId("results").textContent, "Alice");
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});

test("rapid typing coalesces worker rank requests (trailing debounce, task #266)", async () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  ControllableWorker.requests = [];
  holder.Worker = ControllableWorker as unknown as typeof Worker;
  try {
    act(() => {
      render(<WorkerTypingHarness data={workerSearchEntriesA} />);
    });

    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 1);
    });
    assert.equal(ControllableWorker.requests[0]?.payload.query, "co");

    // Two keystrokes back-to-back inside the debounce window: each re-render
    // supersedes the pending timer, so exactly ONE new request fires, carrying
    // the final query. Without the debounce this would post one request per
    // keystroke.
    act(() => {
      fireEvent.click(screen.getByTestId("type-a"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("type-b"));
    });
    assert.equal(screen.getByTestId("query").textContent, "ali");

    await waitFor(() => {
      assert.equal(ControllableWorker.requests.length, 2);
    });
    assert.equal(
      ControllableWorker.requests[1]?.payload.query,
      "ali",
      "rapid typing must coalesce into a single worker request carrying the latest query",
    );
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});
