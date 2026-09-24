// DOM test setup for jsdom/RTL behavioral component tests.
// Vitest loads this before every `*.test.tsx` file through vitest.config.ts.
import "global-jsdom/register";
// oxlint-disable-next-line no-restricted-imports -- Whole-module React shim for classic-runtime test dependencies.
import * as React from "react";

// The Hands SDK source export currently reaches Vitest through its classic JSX
// runtime, so expose React only inside the shared DOM-test harness.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  get length() {
    return this.map.size;
  }
}

for (const storageKey of ["localStorage", "sessionStorage"] as const) {
  const current = globalThis[storageKey] as Storage | undefined;
  if (typeof current?.getItem !== "function") {
    Object.defineProperty(globalThis, storageKey, {
      value: new MemoryStorage(),
      configurable: true,
    });
  }
}

// React ships separate production/development builds and picks one at import
// time from NODE_ENV. The dev build is required for tests: `React.act` and the
// act-environment checks only exist there. Force it before any test file
// imports react (global-jsdom does not pull in react, so this runs first).
process.env.NODE_ENV = "test";

// React 19's `act()` reads this flag to confirm it is in a test environment.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

// jsdom's real window.close() DESTROYS the shared document (document.body
// becomes undefined for every test that runs after it), unlike a browser where
// close() on a non-script-opened page is a no-op. Production code legitimately
// calls window.close() (Native onboarding completion asks the WebView host to
// close, task #311), so neuter it here. Tests that assert the close request
// install their own spy by assigning window.close.
window.close = () => {};

if (typeof globalThis.localStorage?.getItem !== "function") {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}
