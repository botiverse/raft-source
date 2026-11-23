// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// A profile description's Artifact link (the author row, the hover card) is
// drawn as the message body's chip with the Artifact's title once its summary
// answers, and as a short "Artifact" chip (never the address) while it loads
// or when the viewer can't see it (artin). Those chips are still the
// Artifact's link (a plain click opens it in place); the one the viewer can't
// see has the Artifact hover card's shell with only a hint, never the title
// or address, and the description's tooltip never stacks on it (Artea).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@botiverse/raft-ui";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactReference } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { artifactUrl } from "../src/apps/artifacts";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import { registerArtifactShell, useArtifactViewerStore } from "../src/apps/artifacts/artifactViewerStore";
import { fakeArtifactSource } from "../src/apps/artifacts/fakeArtifactSource";
import type { ArtifactLinkTarget } from "../src/apps/artifacts/artifactLinks";
import { ProfileDescription } from "../src/components/message/ProfileDescription";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const SERVER = "server-desc";
const ADDRESS = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";
const OTHER = "https://github.com/botiverse/slock";
const DESCRIPTION = `Stamp 负责人。工作清单：${ADDRESS}，代码：${OTHER}`;
const TITLE = "Stamp 工作清单";

let answer: (target: ArtifactLinkTarget) => ArtifactReference | null = () => null;
/** The summaries' read never answers: the chip stays `loading`. */
let neverAnswer = false;

function cardOf(target: ArtifactLinkTarget): ArtifactCard {
  return {
    id: target.id, url: ADDRESS, title: TITLE, description: null, kind: "markdown",
    facts: { sizeBytes: 100, fileCount: 1 }, preview: { kind: "none" }, version: 1, pinned: false, latestVersion: 1,
    author: { kind: "agent", name: "edgar", displayName: "Edgar" } as ArtifactCard["author"],
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", commentCount: 0, home: { kind: "server" },
  };
}

function mount() {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <TooltipProvider>
          <ProfileDescription text={DESCRIPTION}>{(content) => <span data-testid="description">{content}</span>}</ProfileDescription>
        </TooltipProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  useServerStore.setState({ current: { id: SERVER, slug: "desc", name: "Desc" } } as never);
  act(() => setServerFeatureFlagForTests(SERVER, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true));
  setArtifactSourceForTests({
    ...fakeArtifactSource,
    async getMessageArtifactRefs(inText) {
      if (neverAnswer) return new Promise<never>(() => {});
      return inText.map((target) => answer(target) ?? ({ status: "unavailable" } as unknown as ArtifactReference));
    },
  });
});

afterEach(() => {
  cleanup();
  neverAnswer = false;
  useArtifactViewerStore.setState(useArtifactViewerStore.getInitialState(), true);
  setArtifactSourceForTests(null);
});

test("an Artifact link shows its title chip once its summary answers, and other links stay as written", async () => {
  answer = (target) => ({ status: "ok", card: cardOf(target) });
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, true));
  assert.equal(description.textContent?.includes(TITLE), true);
  assert.equal(description.textContent?.includes(ADDRESS), false);
  assert.equal(description.textContent?.includes(OTHER), true);
  assert.equal(description.textContent?.startsWith("Stamp 负责人。工作清单："), true);
});

test("an Artifact the viewer can't see is a gray Artifact chip, never its address", async () => {
  answer = () => null;
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-description-artifact="unavailable"]') !== null, true));
  assert.equal(description.textContent?.includes("Artifact"), true);
  assert.equal(description.textContent?.includes(ADDRESS), false);
  assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, false);
});

test("with Artifacts off the description is the author's text", () => {
  act(() => setServerFeatureFlagForTests(SERVER, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false));
  mount();
  assert.equal(screen.getByTestId("description").textContent, DESCRIPTION);
});

// The description's own tooltip (the text with the title for the address).
const TOOLTIP_WORDS = `Stamp 负责人。工作清单：${TITLE}，代码：${OTHER}`;
const tooltipShown = () => screen.queryAllByText(TOOLTIP_WORDS).length > 0;
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function mountResolved() {
  answer = (target) => ({ status: "ok", card: cardOf(target) });
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="object"]') !== null, true));
  return { description, chip: description.querySelector<HTMLElement>('[data-app-link-chip="object"]')! };
}

test("keyboard focus on a chip opens its hover card, never the description's tooltip on top", async () => {
  const { description, chip } = await mountResolved();
  // Control: focus on the description itself opens its tooltip.
  description.tabIndex = 0;
  act(() => description.focus());
  fireEvent.focus(description);
  await waitFor(() => assert.equal(tooltipShown(), true));
  act(() => description.blur());
  fireEvent.blur(description);
  await waitFor(() => assert.equal(tooltipShown(), false));

  act(() => chip.focus());
  fireEvent.focus(chip);
  await pause(800);
  assert.equal(tooltipShown(), false);
});

test("a deleted Artifact's chip carries the author's link for share images", async () => {
  answer = () => ({ status: "deleted", title: "Old list", deletedBy: { kind: "agent", name: "edgar", displayName: "Edgar" }, deletedAt: "2026-11-01T00:00:00.000Z" } as unknown as ArtifactReference);
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-app-link-chip="deleted"]') !== null, true));
  const chip = description.querySelector('[data-app-link-chip="deleted"]');
  assert.equal(chip?.getAttribute("data-select-screenshot-author-link"), ADDRESS);
  assert.equal(description.textContent?.includes("Old list"), true);
});

const HINT = "You can't see this Artifact. Open it to see why.";
// The description's tooltip while the Artifact has no title for this viewer: the text as written.
const DESCRIPTION_TOOLTIP_UNANSWERED = () => screen.queryAllByText(DESCRIPTION).length > 0;

/** The pointer onto `element` (the description's tooltip and the chip's card both open on it). */
function hover(element: HTMLElement) {
  fireEvent.pointerOver(element, { pointerType: "mouse" });
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  fireEvent.mouseEnter(element);
  fireEvent.mouseMove(element);
}
function unhover(element: HTMLElement) {
  fireEvent.pointerLeave(element, { pointerType: "mouse" });
  fireEvent.mouseLeave(element);
}
const hintShown = () => screen.queryAllByText(HINT).length > 0;

async function mountUnavailable() {
  answer = () => null;
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('[data-description-artifact="unavailable"] a[href]') !== null, true));
  return { description, chip: description.querySelector<HTMLAnchorElement>('[data-description-artifact="unavailable"] a[href]')! };
}

/** A plain click on `chip` opens its Artifact in place (in the app shell), and its address is the Artifact's page. */
function assertOpensInPlace(chip: HTMLAnchorElement) {
  const unregister = registerArtifactShell();
  try {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => { chip.dispatchEvent(event); });
    const open = useArtifactViewerStore.getState().open;
    assert.equal(open !== null, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(chip.getAttribute("href"), artifactUrl(open!.id, open!.version));
  } finally {
    unregister();
  }
}

test("an Artifact the viewer can't see is still its link: a plain click opens it in place, a modified one is the browser's", async () => {
  const { chip } = await mountUnavailable();
  assert.equal(chip.getAttribute("href")?.includes("/artifacts/"), true);
  assert.equal(chip.getAttribute("aria-label"), "Artifact");
  assert.equal(chip.textContent, "Artifact");
  const unregister = registerArtifactShell();
  try {
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    act(() => { chip.dispatchEvent(modified); });
    assert.equal(useArtifactViewerStore.getState().open !== null, false);
    assert.equal(modified.defaultPrevented, false);
  } finally {
    unregister();
  }
  assertOpensInPlace(chip);
});

test("keyboard focus or hover on the unavailable chip opens its card with the hint, no title or address, never the description's tooltip", async () => {
  const { description, chip } = await mountUnavailable();
  const descriptionTooltip = DESCRIPTION_TOOLTIP_UNANSWERED;
  const card = () => document.querySelector("[data-app-link-preview]");
  assert.equal(chip.classList.contains("cursor-pointer"), true);
  // Control: the pointer on the description's own text opens its tooltip.
  hover(description);
  await waitFor(() => assert.equal(descriptionTooltip(), true), { timeout: 2000 });
  unhover(description);
  await waitFor(() => assert.equal(descriptionTooltip(), false), { timeout: 2000 });
  // Keyboard focus (a Tab onto the chip).
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => chip.focus());
  await waitFor(() => assert.equal(hintShown(), true), { timeout: 2000 });
  assert.equal(card()?.textContent?.includes(ADDRESS), false);
  assert.equal(card()?.textContent?.includes(TITLE), false);
  assert.equal(descriptionTooltip(), false);
  act(() => chip.blur());
  await waitFor(() => assert.equal(hintShown(), false), { timeout: 2000 });

  // The pointer.
  hover(chip);
  await waitFor(() => assert.equal(hintShown(), true), { timeout: 2000 });
  assert.equal(card()?.textContent?.includes(ADDRESS), false);
  await pause(800);
  assert.equal(descriptionTooltip(), false);
});

test("an Artifact link still loading is a link too, with no card of its own", async () => {
  neverAnswer = true;
  mount();
  const description = screen.getByTestId("description");
  await waitFor(() => assert.equal(description.querySelector('a[data-description-artifact="pending"]') !== null, true));
  const chip = description.querySelector<HTMLAnchorElement>('a[data-description-artifact="pending"]')!;
  assert.equal(chip.textContent, "Artifact");
  assert.equal(chip.getAttribute("aria-label"), "Artifact");
  assert.equal(chip.classList.contains("cursor-pointer"), true);
  // A share image turns it back into the author's link.
  assert.equal(chip.getAttribute("data-select-screenshot-author-link"), ADDRESS);
  // Control: the pointer on the description's own text opens its tooltip.
  hover(description);
  await waitFor(() => assert.equal(DESCRIPTION_TOOLTIP_UNANSWERED(), true), { timeout: 2000 });
  unhover(description);
  await waitFor(() => assert.equal(DESCRIPTION_TOOLTIP_UNANSWERED(), false), { timeout: 2000 });
  // Neither the pointer nor keyboard focus on the chip opens it (or a card).
  hover(chip);
  await pause(800);
  assert.equal(DESCRIPTION_TOOLTIP_UNANSWERED(), false);
  unhover(chip);
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => chip.focus());
  await pause(800);
  assert.equal(DESCRIPTION_TOOLTIP_UNANSWERED(), false);
  assert.equal(hintShown(), false);
  assert.equal(document.querySelector("[data-app-link-preview]") !== null, false);
  assertOpensInPlace(chip);
});
