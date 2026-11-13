import { isElectronDesktopShell, shareableWebOrigin, shareableWebUrl } from "../src/utils/desktopShell";

type MutableGlobal = typeof globalThis & { window?: unknown };

afterEach(() => {
  delete (globalThis as MutableGlobal).window;
});

describe("isElectronDesktopShell", () => {
  it("is true only when the Electron preload set raftDesktop.isDesktop", () => {
    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: true } };
    expect(isElectronDesktopShell()).toBe(true);

    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: false } };
    expect(isElectronDesktopShell()).toBe(false);

    (globalThis as MutableGlobal).window = {};
    expect(isElectronDesktopShell()).toBe(false);
  });
});

describe("shareableWebOrigin", () => {
  it("uses the compiled frontend origin in the desktop shell, where the page origin is app://raft", () => {
    // The bug: on desktop window.location.origin is the app://raft custom
    // protocol, so a join link built from it is unopenable. The compiled
    // VITE_FRONTEND_URL is the trusted browser-openable origin.
    expect(shareableWebOrigin(true, "app://raft", "https://app.raft.build")).toBe("https://app.raft.build");
  });

  it("returns the page origin on the Web app (no desktop shell), leaving Web unchanged", () => {
    expect(shareableWebOrigin(false, "https://raft.build", "https://app.raft.build")).toBe("https://raft.build");
    expect(shareableWebOrigin(false, "https://self-hosted.example", "")).toBe("https://self-hosted.example");
  });

  it("does not fabricate an origin: falls back to the page origin if the desktop build shipped without VITE_FRONTEND_URL", () => {
    // The Electron vite config sets a default, so this edge does not occur in
    // real builds; the test documents that we never invent an https origin.
    expect(shareableWebOrigin(true, "app://raft", "")).toBe("app://raft");
  });

  it("wires the real host by default: reads the Electron raftDesktop global for detection", () => {
    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: true }, location: { origin: "app://raft" } };
    // desktop defaults to isElectronDesktopShell() (reads the global) -> true.
    expect(shareableWebOrigin(undefined, undefined, "https://app.raft.build")).toBe("https://app.raft.build");
  });
});

describe("shareableWebUrl", () => {
  it("keeps the page's path, query and hash on the compiled frontend origin in the desktop shell", () => {
    // The bug: Upgrade to Pro sent app://raft/... as the Stripe return URL and
    // the server's redirect check answered "Invalid redirect URL".
    expect(shareableWebUrl(true, "app://raft/s/acme/settings/plan?tab=billing#seats", "https://app.raft.build"))
      .toBe("https://app.raft.build/s/acme/settings/plan?tab=billing#seats");
  });

  it("returns the page URL unchanged on the Web app", () => {
    expect(shareableWebUrl(false, "https://raft.build/s/acme/settings/plan", "https://app.raft.build"))
      .toBe("https://raft.build/s/acme/settings/plan");
  });

  it("does not fabricate an origin when the desktop build has no VITE_FRONTEND_URL", () => {
    expect(shareableWebUrl(true, "app://raft/s/acme", "")).toBe("app://raft/s/acme");
  });

  it("wires the real host by default", () => {
    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: true }, location: { href: "app://raft/s/acme/settings/plan" } };
    expect(shareableWebUrl(undefined, undefined, "https://app.raft.build")).toBe("https://app.raft.build/s/acme/settings/plan");
  });
});
