import assert from "node:assert/strict";
import { SOFT_KEYBOARD_CLOSED_MS, trackVisualViewport } from "../src/utils/visualViewport";

class FakeStyle {
  private values = new Map<string, string>();
  writes = 0;

  setProperty(name: string, value: string): void {
    this.writes += 1;
    this.values.set(name, value);
  }

  removeProperty(name: string): void {
    this.writes += 1;
    this.values.delete(name);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
}

class FakeHTMLElement {
  isContentEditable = false;
}

class FakeInputElement extends FakeHTMLElement {
  type: string;

  constructor(type = "text") {
    super();
    this.type = type;
  }
}

class FakeTextAreaElement extends FakeHTMLElement {}

function installViewportGlobals({
  activeElement,
  innerHeight,
  visualHeight,
  withAnimationFrames = false,
}: {
  activeElement: object | null;
  innerHeight: number;
  visualHeight: number;
  withAnimationFrames?: boolean;
}) {
  // The override is written on #root; <html> must stay untouched (a custom
  // property there restyles the whole document on every change).
  const style = new FakeStyle();
  const dataset: Record<string, string | undefined> = {};
  const rootElementStyle = new FakeStyle();
  const frames: Array<() => void> = [];
  const listeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const visualViewportListeners = new Map<string, Array<() => void>>();

  const addListener = (target: Map<string, Array<() => void>>, type: string, listener: () => void) => {
    const current = target.get(type) ?? [];
    current.push(listener);
    target.set(type, current);
  };

  const fire = (target: Map<string, Array<() => void>>, type: string) => {
    for (const listener of target.get(type) ?? []) listener();
  };

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  };

  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
  Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: FakeInputElement });
  Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: FakeTextAreaElement });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement,
      documentElement: { style: rootElementStyle },
      getElementById: (id: string) => (id === "root" ? { style, dataset } : null),
      hidden: false,
      addEventListener: (type: string, listener: () => void) => {
        addListener(documentListeners, type, listener);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight,
      ...(withAnimationFrames
        ? {
            requestAnimationFrame: (callback: () => void) => {
              frames.push(callback);
              return frames.length;
            },
          }
        : {}),
      visualViewport: {
        height: visualHeight,
        offsetTop: 12,
        addEventListener: (type: string, listener: () => void) => {
          addListener(visualViewportListeners, type, listener);
        },
      },
      addEventListener: (type: string, listener: () => void) => {
        addListener(listeners, type, listener);
      },
    },
  });

  return {
    fireVisualViewport(type: string) {
      fire(visualViewportListeners, type);
    },
    fireWindow(type: string) {
      fire(listeners, type);
    },
    fireDocument(type: string) {
      fire(documentListeners, type);
    },
    setActiveElement(next: object | null) {
      (globalThis.document as unknown as { activeElement: object | null }).activeElement = next;
    },
    setVisualViewport(next: { height?: number; offsetTop?: number }) {
      Object.assign((globalThis.window as unknown as { visualViewport: object }).visualViewport, next);
    },
    pendingFrames() {
      return frames.length;
    },
    flushFrames() {
      for (const callback of frames.splice(0)) callback();
    },
    style,
    dataset,
    rootElementStyle,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(globalThis, name);
        } else {
          Object.defineProperty(globalThis, name, { configurable: true, value });
        }
      }
    },
  };
}

test("trackVisualViewport ignores stale smaller iOS standalone viewport when no text input is focused", () => {
  const env = installViewportGlobals({
    activeElement: null,
    innerHeight: 844,
    visualHeight: 430,
  });

  try {
    trackVisualViewport();

    // Keyboard-only: no override when nothing editable is focused (task #15 CSS path).
    assert.equal(env.style.getPropertyValue("height"), "");
    assert.equal(env.style.getPropertyValue("top"), "");
    assert.equal(env.dataset.softKeyboard, undefined);
  } finally {
    env.restore();
  }
});

test("trackVisualViewport pins root to visual viewport while a text input keyboard is open", () => {
  const env = installViewportGlobals({
    activeElement: new FakeTextAreaElement(),
    innerHeight: 844,
    visualHeight: 430,
  });

  try {
    trackVisualViewport();

    assert.equal(env.style.getPropertyValue("height"), "430px");
    assert.equal(env.style.getPropertyValue("top"), "12px");
    // The phone tab bar hides on this flag rather than riding the keyboard.
    assert.equal(env.dataset.softKeyboard, "open");

    env.setActiveElement(null);
    env.fireVisualViewport("resize");

    assert.equal(env.style.getPropertyValue("height"), "");
    assert.equal(env.style.getPropertyValue("top"), "");
  } finally {
    env.restore();
  }
});

test("trackVisualViewport marks a keyboard close briefly so the tab bar can animate back, then clears it", async () => {
  const env = installViewportGlobals({
    activeElement: new FakeTextAreaElement(),
    innerHeight: 844,
    visualHeight: 430,
  });

  try {
    trackVisualViewport();
    assert.equal(env.dataset.softKeyboard, "open");

    env.setActiveElement(null);
    env.fireVisualViewport("resize");
    // `.mobile-tab-bar-return` (index.css) runs only under this state.
    assert.equal(env.dataset.softKeyboard, "closed");

    await new Promise((resolve) => setTimeout(resolve, SOFT_KEYBOARD_CLOSED_MS + 20));
    assert.equal("softKeyboard" in env.dataset, false, "a later mount does not replay the return");

    // Reopening during the close window wins over the pending clear.
    env.setActiveElement(new FakeTextAreaElement());
    env.fireVisualViewport("resize");
    env.setActiveElement(null);
    env.fireVisualViewport("resize");
    env.setActiveElement(new FakeTextAreaElement());
    env.fireVisualViewport("resize");
    await new Promise((resolve) => setTimeout(resolve, SOFT_KEYBOARD_CLOSED_MS + 20));
    assert.equal(env.dataset.softKeyboard, "open");
  } finally {
    env.restore();
  }
});

test("trackVisualViewport clears stale keyboard override when app resumes without focused text input", () => {
  const env = installViewportGlobals({
    activeElement: new FakeTextAreaElement(),
    innerHeight: 844,
    visualHeight: 430,
  });

  try {
    trackVisualViewport();

    assert.equal(env.style.getPropertyValue("height"), "430px");

    env.setActiveElement(null);
    env.fireWindow("pageshow");

    assert.equal(env.style.getPropertyValue("height"), "");
    assert.equal(env.style.getPropertyValue("top"), "");
  } finally {
    env.restore();
  }
});

test("trackVisualViewport does not treat non-text inputs as keyboard-open", () => {
  const env = installViewportGlobals({
    activeElement: new FakeInputElement("checkbox"),
    innerHeight: 844,
    visualHeight: 430,
  });

  try {
    trackVisualViewport();

    assert.equal(env.style.getPropertyValue("height"), "");
    assert.equal(env.style.getPropertyValue("top"), "");
  } finally {
    env.restore();
  }
});

test("trackVisualViewport measures viewport events once per frame and never rewrites unchanged values", () => {
  const env = installViewportGlobals({
    activeElement: new FakeTextAreaElement(),
    innerHeight: 844,
    visualHeight: 430,
    withAnimationFrames: true,
  });

  try {
    trackVisualViewport();
    assert.equal(env.style.getPropertyValue("height"), "430px");
    const writesAfterPin = env.style.writes;

    // iOS fires these while the reader scrolls with the keyboard up.
    env.fireVisualViewport("scroll");
    env.fireVisualViewport("resize");
    env.fireVisualViewport("scroll");
    assert.equal(env.pendingFrames(), 1, "a burst of viewport events is one measurement");
    env.flushFrames();
    assert.equal(env.style.writes, writesAfterPin, "an unchanged viewport writes nothing");

    env.setVisualViewport({ height: 400 });
    env.fireVisualViewport("resize");
    assert.equal(env.style.getPropertyValue("height"), "430px", "applied in the next frame, not in the event");
    env.flushFrames();
    assert.equal(env.style.getPropertyValue("height"), "400px");
    assert.equal(env.style.writes, writesAfterPin + 1, "only the value that changed is written");

    assert.equal(env.rootElementStyle.writes, 0, "nothing is written on <html>");
  } finally {
    env.restore();
  }
});

// Focus moves inside React commits (switching server unmounts the focused
// sidebar row). Reading `isContentEditable` there forced the commit's whole
// pending style recalc, 117ms after unmounting 300 rows (InNOut,
// #proj-frontend:57f32c96): focus events measure on the next frame, and a
// window with no keyboard gap never inspects the focused element at all.
test("trackVisualViewport never reads the focused element's style inside a focus event, nor when there is no keyboard gap", () => {
  let styleReads = 0;
  class CountingEditable extends FakeHTMLElement {
    override get isContentEditable() {
      styleReads += 1;
      return true;
    }
    override set isContentEditable(_value: boolean) {}
  }
  const env = installViewportGlobals({
    activeElement: new CountingEditable(),
    innerHeight: 900,
    visualHeight: 900,
    withAnimationFrames: true,
  });

  try {
    trackVisualViewport();
    env.fireWindow("focusout");
    env.fireWindow("focusin");
    assert.equal(env.pendingFrames(), 1, "focus events wait for the next frame, once");
    env.flushFrames();
    assert.equal(styleReads, 0, "no keyboard gap: the focused element is never inspected");
    assert.equal(env.style.getPropertyValue("height"), "");
  } finally {
    env.restore();
  }
});
