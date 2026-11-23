import assert from "node:assert/strict";
import "../helpers/domSetup";
import { createContext, memo, useContext, useMemo, useState, useSyncExternalStore } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { summarize } from "./renderWhy";
import { createWhyRecorder } from "./renderWhyRecorder";
import type { WhyFiber } from "./renderWhyRecorder";

// The render-why probe's fiber walk against a real React tree: which
// components of a row rendered in a commit, and the cause found for each.
// The page probe gets the root from React's commit hook; here it is read off
// the container after each single-commit act().

const SECRET = "the words of a message";
const Theme = createContext("light");

let snapshot = { unread: 0 };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function writeStore(unread: number) {
  snapshot = { unread };
  listeners.forEach((listener) => listener());
}

interface Message {
  id: string;
  content: string;
}
const setCount = new Map<string, (n: number) => void>();

function Avatar() {
  return <i />;
}

const Body = memo(function Body({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const [count, setter] = useState(0); // slot 0
  const store = useSyncExternalStore(subscribe, () => snapshot); // slots 1 (store) and 2 (its effect)
  const theme = useContext(Theme); // no slot
  const label = useMemo(() => `${count}${store.unread}${theme}`, [count, store, theme]); // slot 3
  setCount.set(message.id, setter);
  return (
    <div data-message-id={message.id} data-label={label} onClick={onOpen}>
      <Avatar />
      {message.content}
    </div>
  );
});

function Row({ message, onOpen }: { message: Message; onOpen: () => void }) {
  return (
    <div data-timeline-message-id={message.id}>
      <Body message={message} onOpen={onOpen} />
    </div>
  );
}

const MESSAGES: Message[] = [
  { id: "m1", content: SECRET },
  { id: "m2", content: SECRET },
];

const List = memo(function List({ tick }: { tick: number }) {
  // A new function on every render of the list: memo(Body) can never bail out.
  const onOpen = () => undefined;
  return (
    <section data-tick={tick}>
      {MESSAGES.map((message) => (
        <Row key={message.id} message={message} onOpen={onOpen} />
      ))}
    </section>
  );
});

function App({ tick, theme }: { tick: number; theme: string }) {
  return (
    <Theme.Provider value={theme}>
      <List tick={tick} />
    </Theme.Provider>
  );
}

function rootOf(container: Element): { current: WhyFiber } {
  const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
  if (!key) throw new Error("the container has no React root");
  return (container as unknown as Record<string, { stateNode: { current: WhyFiber } }>)[key]!.stateNode;
}

afterEach(() => {
  cleanup();
  setCount.clear();
  listeners.clear();
});

describe("render-why recorder", () => {
  it("attributes each render of a row to what changed", () => {
    const recorder = createWhyRecorder();
    const view = render(<App tick={0} theme="light" />);
    const root = rootOf(view.container);
    const commit = (change: () => void) => {
      recorder.reset();
      act(change);
      recorder.onCommit(root);
      const reading = recorder.read();
      assert.deepEqual(reading.errors, []);
      return { reading, summary: summarize(reading.aggregate) };
    };
    const component = (summary: ReturnType<typeof summarize>, series: string, name: string) => summary.series[series]?.components.find((c) => c.name === name);
    const causes = (summary: ReturnType<typeof summarize>, series: string, name: string) => component(summary, series, name)?.causes.map((c) => [c.cause, c.count]);

    // Mount.
    recorder.onCommit(root);
    const mounted = recorder.read();
    assert.deepEqual(mounted.errors, []);
    const first = summarize(mounted.aggregate);
    assert.deepEqual(first.series.messageBody?.boundaries, ["Body"]);
    assert.deepEqual(first.series.timelineRow?.boundaries, ["List"], "no memo() between the row's node and List: the nearest memo() above is the boundary");
    assert.deepEqual([first.series.messageBody?.rows, first.series.messageBody?.rowRenders.total], [2, 2]);
    assert.deepEqual(causes(first, "messageBody", "Body"), [["mount", 2]]);
    const info = mounted.boundaries.find((b) => b.series === "messageBody");
    assert.deepEqual([info?.name, info?.memo, info?.fibers, info?.nodes, info?.ancestors], ["Body", true, 2, 2, ["Row", "List (memo)", "App"]]);
    const shared = mounted.boundaries.find((b) => b.series === "timelineRow");
    assert.deepEqual([shared?.fibers, shared?.nodes], [1, 2], "two rows under one boundary");

    // The list renders again: its inline callback is new for every row.
    const rerendered = commit(() => view.rerender(<App tick={1} theme="light" />));
    assert.deepEqual(causes(rerendered.summary, "messageBody", "Body"), [["prop:onOpen:identity", 2]]);
    assert.deepEqual(causes(rerendered.summary, "messageBody", "Avatar"), [["parent", 2]]);
    assert.deepEqual(causes(rerendered.summary, "timelineRow", "List"), [["prop:tick:value", 1]]);
    assert.deepEqual(causes(rerendered.summary, "timelineRow", "Row"), [["prop:onOpen:identity", 2]]);
    assert.deepEqual(rerendered.summary.series.messageBody?.initiators.map((i) => [i.started, i.count, i.chain]), [["App: prop:tick:value", 2, ["App", "List", "Row", "Body"]]]);
    assert.deepEqual(rerendered.reading.timeline.map((c) => c.series), [{ messageBody: { mounts: 0, updates: 2 }, timelineRow: { mounts: 0, updates: 1 } }]);

    // One row's own state: the other row, whose fibers still carry the flag of their last render, is not counted.
    const own = commit(() => setCount.get("m1")?.(1));
    assert.deepEqual(own.summary.series.messageBody?.rowRenders, { total: 1, min: 1, median: 1, max: 1 });
    assert.deepEqual(causes(own.summary, "messageBody", "Body"), [["hook:0:state:value", 1]]);
    assert.deepEqual(component(own.summary, "messageBody", "Body")?.parentUpdates, 0);
    assert.deepEqual(causes(own.summary, "messageBody", "Avatar"), [["parent", 1]]);
    assert.equal(component(own.summary, "timelineRow", "Row"), undefined);
    assert.deepEqual(own.summary.series.messageBody?.initiators.map((i) => i.started), ["Body: hook:0:state:value"]);

    // A store every row subscribes to.
    const stored = commit(() => writeStore(1));
    assert.deepEqual(causes(stored.summary, "messageBody", "Body"), [["hook:1:syncExternalStore:value", 2]]);
    assert.equal(component(stored.summary, "messageBody", "Body")?.causes[0]?.ordinal, 0);

    // A context every row reads, through a memo() parent that does not render.
    const themed = commit(() => view.rerender(<App tick={1} theme="dark" />));
    assert.deepEqual(causes(themed.summary, "messageBody", "Body"), [["context:#1:value", 2]]);
    assert.equal(component(themed.summary, "timelineRow", "List"), undefined);

    // Nothing happened to the rows: nothing is counted.
    const idle = commit(() => view.rerender(<App tick={1} theme="dark" />));
    assert.deepEqual(idle.summary.series.messageBody?.rowRenders.total ?? 0, 0);

    for (const reading of [mounted, rerendered.reading, own.reading, stored.reading, themed.reading]) assert.ok(!JSON.stringify(reading).includes(SECRET), "no message text in a reading");
  });
});
