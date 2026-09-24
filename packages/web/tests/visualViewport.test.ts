import assert from "node:assert/strict";
import test from "node:test";
import { trackVisualViewport } from "../src/utils/visualViewport";

class FakeStyle {
  private values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeProperty(name: string): void {
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
}: {
  activeElement: object | null;
  innerHeight: number;
  visualHeight: number;
}) {
  const style = new FakeStyle();
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
      documentElement: { style },
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
    style,
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
    assert.equal(env.style.getPropertyValue("--vv-height"), "");
    assert.equal(env.style.getPropertyValue("--vv-offset-top"), "");
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

    assert.equal(env.style.getPropertyValue("--vv-height"), "430px");
    assert.equal(env.style.getPropertyValue("--vv-offset-top"), "12px");

    env.setActiveElement(null);
    env.fireVisualViewport("resize");

    assert.equal(env.style.getPropertyValue("--vv-height"), "");
    assert.equal(env.style.getPropertyValue("--vv-offset-top"), "");
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

    assert.equal(env.style.getPropertyValue("--vv-height"), "430px");

    env.setActiveElement(null);
    env.fireWindow("pageshow");

    assert.equal(env.style.getPropertyValue("--vv-height"), "");
    assert.equal(env.style.getPropertyValue("--vv-offset-top"), "");
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

    assert.equal(env.style.getPropertyValue("--vv-height"), "");
    assert.equal(env.style.getPropertyValue("--vv-offset-top"), "");
  } finally {
    env.restore();
  }
});
