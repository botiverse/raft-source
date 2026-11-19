import { describe, expect, it } from "vitest";

import { fitBrowserHead, GRIP_ROOM, TAB_MIN_WIDTH } from "../src/features/webPreview/browserHeadFit";

// The tab strip owns its hit area (#proj-workspace:#296): where the head carries the grip that moves the panel, the
// fit keeps the grip's room free after New tab, so the grip never stands over a tab or its close button.
describe("fitBrowserHead: the grip's room", () => {
  const head = { chip: false, tabs: 4, frontWidth: 120, controls: 2 };
  // The narrowest head that still shows all four tabs when it has no grip.
  let narrowest = 0;
  for (let width = 200; width < 2000; width += 1) {
    if (fitBrowserHead({ ...head, width }).tabsShown === 4) {
      narrowest = width;
      break;
    }
  }

  it("shows fewer tabs at the same width once the head carries the grip", () => {
    expect(narrowest).toBeGreaterThan(0);
    expect(fitBrowserHead({ ...head, width: narrowest, grip: true }).tabsShown).toBeLessThan(4);
  });

  it("shows them all again once the head is wider by the grip's room", () => {
    const withGrip = (width: number) => fitBrowserHead({ ...head, width, grip: true }).tabsShown;
    expect(withGrip(narrowest + GRIP_ROOM - 1)).toBeLessThan(4);
    expect(withGrip(narrowest + GRIP_ROOM + 16)).toBe(4);
  });

  it("is unchanged for a head without the grip", () => {
    expect(fitBrowserHead({ ...head, width: narrowest, grip: false })).toEqual(fitBrowserHead({ ...head, width: narrowest }));
  });
});

// Every tab is [icon][title][close]: a tab behind keeps about 25px of title beside its fixed parts (63px), so
// crowded tabs can still be told apart. The fit and the drawn slot read the one number.
describe("fitBrowserHead: a tab behind at its narrowest", () => {
  const head = { chip: false, frontWidth: 120, controls: 2 };
  const narrowestFor = (tabs: number) => {
    for (let width = 200; width < 2000; width += 1) if (fitBrowserHead({ ...head, tabs, width }).tabsShown === tabs) return width;
    return 0;
  };

  it("keeps room for the icon, the close button and a few letters of the title", () => {
    expect(TAB_MIN_WIDTH - 63).toBeGreaterThanOrEqual(25);
  });

  it("gives each further tab its minimum and the gap before it", () => {
    expect(narrowestFor(4) - narrowestFor(3)).toBe(TAB_MIN_WIDTH + 2);
  });
});
