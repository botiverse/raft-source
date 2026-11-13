import { describe, expect, it } from "vitest";
import { desktopRouteFromDeepLink, desktopRouteFromPath, isDesktopDeepLinkPathname } from "./desktopRoutes";

describe("desktop routes", () => {
  it("accepts the server routes and the server picker, by path segment", () => {
    expect(isDesktopDeepLinkPathname("/s/acme/channel/c")).toBe(true);
    expect(isDesktopDeepLinkPathname("/servers")).toBe(true);
    expect(isDesktopDeepLinkPathname("/servers/new")).toBe(true);
    expect(isDesktopDeepLinkPathname("/serversX")).toBe(false);
    expect(isDesktopDeepLinkPathname("/s")).toBe(false);
    expect(isDesktopDeepLinkPathname("/login")).toBe(false);
  });

  it("accepts the canonical Artifact link, not the bare list path", () => {
    expect(isDesktopDeepLinkPathname("/artifacts/AfA4bUnLupXyb7Vh5d3aiJ")).toBe(true);
    expect(isDesktopDeepLinkPathname("/artifacts/AfA4bUnLupXyb7Vh5d3aiJ/v/3")).toBe(true);
    expect(isDesktopDeepLinkPathname("/artifacts")).toBe(false);
    expect(isDesktopDeepLinkPathname("/artifactsX/a")).toBe(false);
    expect(desktopRouteFromDeepLink("raft:///artifacts/AfA4bUnLupXyb7Vh5d3aiJ/v/3?file=a.md")).toBe("/artifacts/AfA4bUnLupXyb7Vh5d3aiJ/v/3?file=a.md");
    expect(desktopRouteFromDeepLink("raft://artifacts/AfA4bUnLupXyb7Vh5d3aiJ")).toBe("/artifacts/AfA4bUnLupXyb7Vh5d3aiJ");
    expect(desktopRouteFromPath("/artifacts/../login")).toBeNull();
  });

  it("keeps query and hash, resolves dot segments, and rejects anything that is not a plain in-app path", () => {
    expect(desktopRouteFromPath("/s/a/channel/b?msg=1#x")).toBe("/s/a/channel/b?msg=1#x");
    expect(desktopRouteFromPath("/")).toBe("/");
    expect(desktopRouteFromPath("/s/a/../../login")).toBeNull();
    expect(desktopRouteFromPath("//evil.example/s/a")).toBeNull();
    expect(desktopRouteFromPath("/s\\a")).toBeNull();
    expect(desktopRouteFromPath("s/a")).toBeNull();
    expect(desktopRouteFromPath(`/s/${"x".repeat(3000)}`)).toBeNull();
  });

  it("reads raft:// links with or without the empty host", () => {
    expect(desktopRouteFromDeepLink("raft:///s/a")).toBe("/s/a");
    expect(desktopRouteFromDeepLink("raft://s/a")).toBe("/s/a");
    expect(desktopRouteFromDeepLink("https://app.raft.build/s/a")).toBeNull();
  });
});
