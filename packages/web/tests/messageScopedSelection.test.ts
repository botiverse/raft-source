import assert from "node:assert/strict";
import test from "node:test";
import { getTextSelectionWithinElement } from "../src/components/message/messageScopedSelection";

type FakeNode = {
  name: string;
  childNodes?: FakeNode[];
  contains?: (node: FakeNode) => boolean;
};

function createRoot(children: FakeNode[] = []): FakeNode {
  const root: FakeNode = {
    name: "root",
    childNodes: children,
    contains: (node) => node === root || children.includes(node),
  };
  return root;
}

test("returns normal selection text when both endpoints are inside the message body", () => {
  const textNode = { name: "paragraph" };
  const root = createRoot([textNode]);
  const selection = {
    isCollapsed: false,
    toString: () => "selected paragraph",
    anchorNode: textNode,
    focusNode: textNode,
    rangeCount: 0,
  };

  assert.equal(
    getTextSelectionWithinElement(selection as unknown as Selection, root as unknown as HTMLElement),
    "selected paragraph",
  );
});

test("clips boundary selections whose focus lands just outside the message body", () => {
  const textNode = { name: "last paragraph" };
  const outside = { name: "outside" };
  const root = createRoot([textNode]);
  let endWasClippedToRoot = false;
  const range = {
    startContainer: textNode,
    endContainer: outside,
    intersectsNode: (node: FakeNode) => node === root,
    cloneRange: () => ({
      startContainer: textNode,
      endContainer: outside,
      setStart: () => {
        throw new Error("start should already be inside the message body");
      },
      setEnd: (node: FakeNode) => {
        endWasClippedToRoot = node === root;
      },
      cloneContents: () => ({ textContent: "last paragraph" }),
    }),
  };
  const selection = {
    isCollapsed: false,
    toString: () => "last paragraph",
    anchorNode: textNode,
    focusNode: outside,
    rangeCount: 1,
    getRangeAt: () => range,
  };

  assert.equal(
    getTextSelectionWithinElement(selection as unknown as Selection, root as unknown as HTMLElement),
    "last paragraph",
  );
  assert.equal(endWasClippedToRoot, true);
});

test("rejects selections that do not intersect the message body", () => {
  const inside = { name: "inside" };
  const outside = { name: "outside" };
  const root = createRoot([inside]);
  const selection = {
    isCollapsed: false,
    toString: () => "outside",
    anchorNode: outside,
    focusNode: outside,
    rangeCount: 1,
    getRangeAt: () => ({
      intersectsNode: () => false,
    }),
  };

  assert.equal(
    getTextSelectionWithinElement(selection as unknown as Selection, root as unknown as HTMLElement),
    "",
  );
});
