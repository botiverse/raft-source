import { describe, expect, expectTypeOf, it } from "vitest";
import type { DesktopLaunchInfo, RaftDesktopBridge } from "./desktopBridge";

// The bridge contract the Desktop preload satisfies and the web reads
// (apps/desktop/src/app/preload.ts, packages/web/src/utils/desktopBridge.ts).
describe("desktop bridge contract", () => {
  it("types how the shell opened the window: the route an update resume reopened, or null", () => {
    expectTypeOf<RaftDesktopBridge["launch"]>().toEqualTypeOf<DesktopLaunchInfo | undefined>();
    expectTypeOf<DesktopLaunchInfo["resumedRoute"]>().toEqualTypeOf<string | null>();
    const launch: DesktopLaunchInfo = { resumedRoute: "/s/acme/channel/c1?thread=c2%3Ap1" };
    expect(launch.resumedRoute).toBe("/s/acme/channel/c1?thread=c2%3Ap1");
  });
});
