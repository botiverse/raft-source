// A small stand-in for the Navigation API (`window.navigation`), which jsdom
// does not implement: entries with stable keys, the current entry, and
// `currententrychange`. `installFakeNavigation` binds one to jsdom's
// window.history so a BrowserRouter app keeps both in step, the way a browser
// does (pushState adds an entry and prunes forward ones, replaceState keeps the
// key, history.go moves the current entry).

interface FakeEntry {
  key: string;
  index: number;
  url: string;
}

export interface FakeNavigation {
  readonly currentEntry: FakeEntry | null;
  entries(): FakeEntry[];
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
  push(url: string): void;
  replace(url: string): void;
  traverse(delta: number): void;
}

/**
 * `otherDocument` adds the same-origin entries an earlier document left in the
 * tab (navigation.entries() lists them too): `before` the current one (a full
 * reload or location.assign started this document) and `after` it (a reload
 * mid-stack keeps the old forward entries).
 */
export function createFakeNavigation(
  initialUrl: string,
  otherDocument: { before?: readonly string[]; after?: readonly string[] } = {},
): FakeNavigation {
  let nextKey = 0;
  const urls = [...(otherDocument.before ?? []), initialUrl, ...(otherDocument.after ?? [])];
  let list: FakeEntry[] = urls.map((url, index) => ({ key: `k${nextKey++}`, index, url }));
  let current = otherDocument.before?.length ?? 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get currentEntry() {
      return list[current] ?? null;
    },
    entries: () => list.map((entry) => ({ ...entry })),
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    push(url) {
      list = [...list.slice(0, current + 1), { key: `k${nextKey++}`, index: current + 1, url }];
      current = list.length - 1;
      changed();
    },
    replace(url) {
      list = list.map((entry, i) => (i === current ? { ...entry, url } : entry));
      changed();
    },
    traverse(delta) {
      const target = current + delta;
      if (target < 0 || target >= list.length || delta === 0) return;
      current = target;
      changed();
    },
  };
}

/** Install a fake bound to `win.history`; returns it and an uninstall function. */
export function installFakeNavigation(
  win: Window = window,
  otherDocument?: Parameters<typeof createFakeNavigation>[1],
): { navigation: FakeNavigation; uninstall: () => void } {
  const history = win.history;
  const navigation = createFakeNavigation(win.location.href, otherDocument);
  const { pushState, replaceState, go } = history;
  const absolute = (url: string | URL | null | undefined) => new URL(String(url ?? win.location.href), win.location.href).href;
  history.pushState = function patchedPush(data, unused, url) {
    pushState.call(history, data, unused, url);
    navigation.push(absolute(url));
  };
  history.replaceState = function patchedReplace(data, unused, url) {
    replaceState.call(history, data, unused, url);
    navigation.replace(absolute(url));
  };
  history.go = function patchedGo(delta) {
    navigation.traverse(delta ?? 0);
    go.call(history, delta);
  };
  (win as unknown as { navigation?: FakeNavigation }).navigation = navigation;
  return {
    navigation,
    uninstall: () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      history.go = go;
      delete (win as unknown as { navigation?: FakeNavigation }).navigation;
    },
  };
}
