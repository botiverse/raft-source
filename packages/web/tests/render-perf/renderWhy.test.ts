import assert from "node:assert/strict";
import {
  addRecord,
  causeLine,
  causesOf,
  changeKind,
  createAggregate,
  createIdRegistry,
  describeValue,
  diffContexts,
  diffHooks,
  diffProps,
  hookKind,
  mergeAggregates,
  summarize,
  summaryMarkdown,
} from "./renderWhy";
import type { ContextNode, HookNode, RenderRecord } from "./renderWhy";

// The render-why probe's pure half: what changed between two renders, and how
// the renders of a step add up to ranked causes. No React, no bundle.

const SECRET = "the words of a message";

function hooks(...slots: Array<Pick<HookNode, "memoizedState" | "queue">>): HookNode | null {
  let head: HookNode | null = null;
  for (const slot of slots.reverse()) head = { ...slot, next: head };
  return head;
}
const state = (value: unknown) => ({ memoizedState: value, queue: { pending: null, dispatch: () => undefined, lastRenderedReducer: () => undefined } });
const store = (value: unknown) => ({ memoizedState: value, queue: { value, getSnapshot: () => value } });
const memo = (value: unknown, deps: unknown[] | null = []) => ({ memoizedState: [value, deps], queue: null });
const effect = () => ({ memoizedState: { tag: 9, create: () => undefined, deps: null, inst: {}, next: null }, queue: null });
const ref = (current: unknown) => ({ memoizedState: { current }, queue: null });

function record(over: Partial<RenderRecord>): RenderRecord {
  return { series: "messageBody", path: "Body", name: "Body", boundary: true, memo: true, instance: 1, rowId: "m1", phase: "update", props: [], hooks: [], contexts: [], recomputed: 0, parentRendered: true, ...over };
}

describe("describeValue", () => {
  it("reduces a value to its type, size, id and identity, never its content", () => {
    const ids = createIdRegistry();
    assert.equal(describeValue(SECRET, ids), `string(${SECRET.length})`);
    assert.equal(describeValue(42, ids), "number");
    assert.equal(describeValue(true, ids), "true");
    assert.equal(describeValue(null, ids), "null");
    const message = { id: "msg-1", content: SECRET, seq: 7 };
    assert.equal(describeValue(message, ids), "object{id,content,seq} id=msg-1#1");
    assert.equal(describeValue(message, ids), "object{id,content,seq} id=msg-1#1", "the same object keeps its number");
    assert.equal(describeValue([message, message], ids), "array(2)<object{id,content,seq} id=msg-1>#2");
    assert.equal(describeValue(new Map([[SECRET, 1]]), ids), "Map(1)#3");
    assert.equal(describeValue(function onOpen() {}, ids), "fn onOpen#4");
    assert.equal(describeValue({ $$typeof: Symbol.for("react.transitional.element"), type: function Avatar() {}, props: {} }, ids), "element<Avatar>");
  });

  it("gives only the size of a dictionary, whose keys can be names or text", () => {
    const ids = createIdRegistry();
    assert.equal(describeValue({ [SECRET]: 1, "@someone": 2 }, ids), "object(2 keys)#1");
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]));
    assert.equal(describeValue(many, ids), "object(13 keys)#2");
    assert.equal(describeValue({ id: SECRET }, ids), "object{id}#3", "an id that is not id-shaped is left out");
  });
});

describe("changeKind", () => {
  it("tells a new reference with the same content from changed content", () => {
    assert.equal(changeKind([1, 2], [1, 2]), "identity");
    assert.equal(changeKind([1, 2], [1, 3]), "value");
    assert.equal(changeKind({ a: 1 }, { a: 1 }), "identity");
    assert.equal(changeKind({ a: 1 }, { a: 1, b: 2 }), "value");
    assert.equal(changeKind(() => 1, () => 1), "identity");
    assert.equal(changeKind(() => 1, () => 2), "value");
    assert.equal(changeKind("a", "b"), "value");
    assert.equal(changeKind(new Map(), new Map()), "value", "not compared: reported as changed");
  });
});

describe("diffProps", () => {
  it("lists the changed keys, with the changed fields of an object", () => {
    const ids = createIdRegistry();
    const onOpen = () => undefined;
    const prev = { message: { id: "m1", content: SECRET, reactions: 1 }, channels: ["a"], onOpen, compact: false };
    const next = { message: { id: "m1", content: SECRET, reactions: 2 }, channels: ["a"], onOpen, compact: false, extra: 1 };
    const changes = diffProps(prev, next, ids);
    assert.deepEqual(changes.map((c) => [c.key, c.kind]), [["message", "value"], ["channels", "identity"], ["extra", "value"]]);
    assert.deepEqual(changes[0]?.inner, ["reactions"]);
    assert.ok(!JSON.stringify(changes).includes(SECRET));
    assert.deepEqual(diffProps(prev, prev, ids), []);
  });
});

describe("hooks", () => {
  it("names a hook's kind from its slot", () => {
    assert.equal(hookKind({ ...state(1), next: null }), "state");
    assert.equal(hookKind({ ...store(1), next: null }), "syncExternalStore");
    assert.equal(hookKind({ ...memo({}), next: null }), "memo");
    assert.equal(hookKind({ ...memo(() => 1), next: null }), "callback");
    assert.equal(hookKind({ ...effect(), next: null }), "effect");
    assert.equal(hookKind({ ...ref(1), next: null }), "ref");
    assert.equal(hookKind({ memoizedState: "r1", queue: null, next: null }), "other");
  });

  it("reports changed state and store slots by index and by position among their kind", () => {
    const ids = createIdRegistry();
    const list = ["a"];
    const prev = hooks(state(0), memo(() => 1), store(list), effect(), ref(1), store("x"), memo({ a: 1 }));
    const next = hooks(state(0), memo(() => 1), store(["a"]), effect(), ref(2), store("yy"), memo({ a: 1 }));
    const diff = diffHooks(prev, next, ids);
    assert.equal(diff.slots, 7);
    assert.equal(diff.recomputed, 2, "both memo slots hold a new value; a ref or an effect never counts");
    assert.deepEqual(diff.hooks.map((h) => [h.index, h.hook, h.ordinal, h.kind]), [[2, "syncExternalStore", 0, "identity"], [5, "syncExternalStore", 1, "value"]]);
    assert.equal(diff.hooks[1]?.next, "string(2)");
  });
});

describe("diffContexts", () => {
  it("compares the contexts a component read, by context", () => {
    const ids = createIdRegistry();
    const a = { displayName: "Router" };
    const b = {};
    const chain = (va: unknown, vb: unknown): ContextNode => ({ context: a, memoizedValue: va, next: { context: b, memoizedValue: vb, next: null } });
    const changes = diffContexts(chain({ path: "/a" }, 1), chain({ path: "/a" }, 2), (c) => (c as { displayName?: string }).displayName ?? "#2", ids);
    assert.deepEqual(changes.map((c) => [c.key, c.kind]), [["Router", "identity"], ["#2", "value"]]);
  });
});

describe("causesOf", () => {
  const none = { props: [], hooks: [], contexts: [] };
  it("orders own causes first and falls back to the parent", () => {
    assert.deepEqual(causesOf({ phase: "mount", memo: true, ...none, parentRendered: true }), ["mount"]);
    assert.deepEqual(causesOf({ phase: "update", memo: false, ...none, parentRendered: true }), ["parent"]);
    assert.deepEqual(causesOf({ phase: "update", memo: true, ...none, parentRendered: true }), ["unknown"], "memo() with equal props does not render for its parent");
    assert.deepEqual(causesOf({ phase: "update", memo: false, ...none, parentRendered: false }), ["unknown"]);
    const ids = createIdRegistry();
    const input = {
      phase: "update" as const,
      memo: true,
      props: diffProps({ onOpen: () => 1 }, { onOpen: () => 1 }, ids),
      hooks: diffHooks(hooks(state(1)), hooks(state(2)), ids).hooks,
      contexts: [],
      parentRendered: true,
    };
    assert.deepEqual(causesOf(input), ["hook:0:state:value", "prop:onOpen:identity"]);
  });
});

describe("aggregation", () => {
  const ids = createIdRegistry();
  const unstable = () => diffProps({ onOpen: () => 1 }, { onOpen: () => 1 }, ids);
  const storeChange = () => diffHooks(hooks(state(0), store(["a"])), hooks(state(0), store(["a", "b"])), ids).hooks;

  function step() {
    const aggregate = createAggregate();
    aggregate.commits = 5;
    for (const [instance, rowId] of [[1, "m1"], [2, "m2"]] as const) {
      addRecord(aggregate, record({ instance, rowId, phase: "mount" }));
      // 3 updates for an unstable callback from the list, 1 of them with a store change too; 1 for the store alone.
      const fromList = { name: "List", causes: ["hook:4:state:value"], chain: ["List", "Row", "Body"] };
      addRecord(aggregate, record({ instance, rowId, props: unstable(), initiator: fromList }));
      addRecord(aggregate, record({ instance, rowId, props: unstable(), initiator: fromList }));
      addRecord(aggregate, record({ instance, rowId, props: unstable(), hooks: storeChange(), initiator: fromList }));
      addRecord(aggregate, record({ instance, rowId, hooks: storeChange(), parentRendered: false, initiator: { name: "Body", causes: ["hook:1:syncExternalStore:value"], chain: ["Body"] } }));
      // A child without memo() renders with each of them.
      for (let i = 0; i < 5; i++) addRecord(aggregate, record({ instance: 10 + instance, rowId, boundary: false, memo: false, name: "Avatar", path: "Body > Avatar", phase: i === 0 ? "mount" : "update" }));
    }
    return aggregate;
  }

  it("ranks the causes of a component's updates", () => {
    const summary = summarize(step());
    const series = summary.series.messageBody!;
    assert.equal(series.rows, 2);
    assert.deepEqual(series.rowRenders, { total: 10, min: 5, median: 5, max: 5 });
    assert.deepEqual(series.boundaries, ["Body"]);
    const [body, avatar] = series.components;
    assert.equal(body?.name, "Body");
    assert.deepEqual([body?.renders, body?.mounts, body?.updates, body?.rendersPerRow, body?.ownUpdates, body?.parentUpdates, body?.maxPerInstance], [10, 2, 8, 5, 4, 6, 5]);
    assert.deepEqual(body?.causes.map((c) => [c.cause, c.count, c.of]), [["prop:onOpen:identity", 6, 8], ["hook:1:syncExternalStore:value", 4, 8], ["mount", 2, 10]]);
    assert.equal(causeLine(body!.causes[0]!).split(" — ")[0], "prop `onOpen` new identity, same content: 6 of 8 updates");
    assert.match(causeLine(body!.causes[1]!), /^useSyncExternalStore slot 1 changed \(1st of its kind\): 4 of 8 updates — e\.g\. array\(1\)<string\(1\)>#\d+ -> array\(2\)<string\(1\)>#\d+$/);
    assert.deepEqual(body?.combos[0], { causes: "prop:onOpen:identity", count: 4 });
    assert.deepEqual(avatar?.causes.map((c) => [c.cause, c.count, c.of]), [["parent", 8, 8], ["mount", 2, 10]]);
    assert.deepEqual(series.initiators.map((i) => [i.started, i.count]), [["List: hook:4:state:value", 6], ["Body: hook:1:syncExternalStore:value", 2]]);
  });

  it("sums visits without mixing their rows", () => {
    const merged = summarize(mergeAggregates([step(), step()]));
    const series = merged.series.messageBody!;
    assert.equal(merged.commits, 10);
    assert.equal(series.rows, 4);
    assert.equal(series.components[0]?.instances, 4);
    assert.equal(series.components[0]?.rendersPerRow, 5);
    assert.equal(series.components[0]?.causes[0]?.count, 12);
    assert.equal(series.initiators[0]?.count, 12);
  });

  it("writes the report", () => {
    const text = summaryMarkdown("switch_back", summarize(step())).join("\n");
    assert.match(text, /### switch_back \/ messageBody: 2 row\(s\), 10 boundary render\(s\) \(per row: min 5, median 5, max 5\)/);
    assert.match(text, /- 6× `List: hook:4:state:value` — via List > Row > Body/);
    assert.match(text, /- prop `onOpen` new identity, same content: 6 of 8 updates/);
    assert.match(text, /- parent rendered, nothing of its own changed \(no memo\(\) in between\): 8 of 8 updates/);
  });
});
